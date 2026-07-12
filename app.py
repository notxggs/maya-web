"""
Dashboard backend. Runs in the same process as the bot, sharing
bot.db and bot.lavalink directly, so play/pause/skip/queue actions
from the website take effect immediately in the actual voice call.
"""

import os
import secrets
import asyncio
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from dashboard import oauth

BASE_DIR = Path(__file__).parent
# Railway/Render/Fly inject the public port via $PORT — fall back to
# DASHBOARD_PORT (or 8080) for local development.
DASHBOARD_PORT = int(os.getenv("PORT", os.getenv("DASHBOARD_PORT", "8080")))
DASHBOARD_HOST = os.getenv("DASHBOARD_HOST", "0.0.0.0")

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def create_dashboard(bot) -> FastAPI:
    app = FastAPI(title="Rose Dashboard", docs_url=None, redoc_url=None)
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

    # Track connected dashboard clients per guild so we can push live
    # player updates (song changed, paused, queue updated, etc.)
    app.state.ws_clients: dict[int, set[WebSocket]] = {}
    app.state.oauth_states: set[str] = set()
    
    # Cache of {discord_user_id: {"guild_ids": set(...), "fetched_at": float}}
    # populated at login so /api/guilds doesn't re-hit Discord's API
    # on every page load.
    app.state.guild_cache: dict[str, dict] = {}


    # ── Helpers ──────────────────────────────────────────────────

    def get_session(request: Request) -> dict | None:
        token = request.cookies.get("rose_session")
        if not token:
            return None
        return oauth.read_session_token(token)

    def require_session(request: Request) -> dict:
        session = get_session(request)
        if not session:
            raise HTTPException(status_code=401, detail="Not logged in")
        return session

    async def member_permission_level(guild, user_id: int) -> str | None:
        """Returns 'owner' | 'manager' | 'member' | None (not in guild).
        Falls back to fetch_member() if not cached locally."""
        member = guild.get_member(user_id)
        if member is None:
            try:
                member = await guild.fetch_member(user_id)
            except Exception:
                return None
        if guild.owner_id == user_id or user_id in bot.owner_ids:
            return "owner"
        if member.guild_permissions.manage_guild:
            return "manager"
        return "member"

    def _track_thumbnail(track) -> str | None:
        """Resolve a thumbnail the same way the Discord embed does,
        so both stay in sync. Falls back locally if the cog isn't loaded."""
        if not track:
            return None
        music_cog = bot.get_cog("Music")
        if music_cog and hasattr(music_cog, "_get_thumbnail"):
            try:
                thumb = music_cog._get_thumbnail(track)
                if thumb:
                    return thumb
            except Exception:
                pass
        artwork = getattr(track, "artwork_url", None)
        if artwork:
            return artwork
        try:
            source = (getattr(track, "source_name", "") or "").lower()
            uri = (track.uri or "").lower()
            if "youtube" in source or "youtube" in uri or "youtu.be" in uri:
                return f"https://img.youtube.com/vi/{track.identifier}/hqdefault.jpg"
        except Exception:
            pass
        return None

    def player_to_dict(guild_id: int) -> dict:
        """Serialize the current lavalink player state for JSON/WebSocket."""
        lavalink = getattr(bot, "lavalink", None)
        if not lavalink:
            return {"connected": False}
        player = lavalink.player_manager.get(guild_id)
        if not player or not player.is_connected:
            return {"connected": False}

        music_cog = bot.get_cog("Music")
        current = player.current
        queue = []
        for i, track in enumerate(player.queue[:25]):
            queue.append({
                "index": i,
                "title": track.title,
                "author": track.author,
                "duration": track.duration,
                "uri": track.uri,
                "requester": track.requester,
                "thumbnail": _track_thumbnail(track),
            })

        return {
            "connected": True,
            "paused": player.paused,
            "volume": player.volume,
            "loop": bool(getattr(player, "loop", False)),
            "autoplay": bool(music_cog.autoplay_states.get(guild_id, False)) if music_cog else False,
            "position": player.position if current else 0,
            "current": {
                "title": current.title,
                "author": current.author,
                "duration": current.duration,
                "uri": current.uri,
                "requester": current.requester,
                "identifier": current.identifier,
                "thumbnail": _track_thumbnail(current),
            } if current else None,
            "queue": queue,
            "queue_length": len(player.queue),
        }

    async def broadcast_player_update(guild_id: int):
        clients = app.state.ws_clients.get(guild_id)
        if not clients:
            return
        payload = {"type": "player_update", "data": player_to_dict(guild_id)}
        dead = []
        for ws in clients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)

    # Expose the broadcaster so cogs/music.py can call it after
    # play/pause/skip/etc so the dashboard updates in real time
    # without the browser needing to poll.
    bot.dashboard_broadcast = broadcast_player_update

    # ── Auth routes ──────────────────────────────────────────────

    @app.get("/auth/login")
    async def auth_login():
        state = secrets.token_urlsafe(24)
        app.state.oauth_states.add(state)
        return RedirectResponse(oauth.build_authorize_url(state))

    @app.get("/auth/callback")
    async def auth_callback(request: Request, code: str = None, state: str = None, error: str = None):
        if error or not code:
            return RedirectResponse("/?error=login_failed")

        if state not in app.state.oauth_states:
            return RedirectResponse("/?error=invalid_state")
        app.state.oauth_states.discard(state)

        token_data = await oauth.exchange_code(code)
        if not token_data:
            return RedirectResponse("/?error=token_exchange_failed")

        user = await oauth.fetch_user(token_data["access_token"])
        if not user:
            return RedirectResponse("/?error=user_fetch_failed")

        session_token = oauth.create_session_token(user)

        # Cache the user's guild list briefly so /api/guilds doesn't
        # need to re-hit Discord's API on every page load.
        guilds = await oauth.fetch_user_guilds(token_data["access_token"])
        app.state.guild_cache[user["id"]] = {
            "guild_ids": {g["id"] for g in guilds},
            "fetched_at": asyncio.get_event_loop().time(),
        }

        resp = RedirectResponse("/dashboard")
        resp.set_cookie(
            "rose_session", session_token,
            max_age=oauth.SESSION_MAX_AGE, httponly=True, samesite="lax"
        )
        return resp

    @app.get("/auth/logout")
    async def auth_logout():
        resp = RedirectResponse("/")
        resp.delete_cookie("rose_session")
        return resp

    # ── Page routes ──────────────────────────────────────────────

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request):
        session = get_session(request)
        return templates.TemplateResponse("index.html", {
            "request": request,
            "session": session,
            "bot_name": getattr(bot, "user", None) and bot.user.name or "Rose",
            "guild_count": len(bot.guilds),
        })

    @app.get("/docs", response_class=HTMLResponse)
    async def docs_page(request: Request):
        session = get_session(request)
        return templates.TemplateResponse("docs.html", {
            "request": request,
            "session": session,
        })

    @app.get("/commands", response_class=HTMLResponse)
    async def commands_page(request: Request):
        session = get_session(request)
        return templates.TemplateResponse("commands.html", {
            "request": request,
            "session": session,
        })

    @app.get("/terms", response_class=HTMLResponse)
    async def terms_page(request: Request):
        session = get_session(request)
        return templates.TemplateResponse("terms.html", {
            "request": request,
            "session": session,
        })

    @app.get("/privacy", response_class=HTMLResponse)
    async def privacy_page(request: Request):
        session = get_session(request)
        return templates.TemplateResponse("privacy.html", {
            "request": request,
            "session": session,
        })

    @app.get("/dashboard", response_class=HTMLResponse)
    async def dashboard_home(request: Request):
        session = require_session(request)
        return templates.TemplateResponse("guilds.html", {
            "request": request,
            "session": session,
            "avatar": oauth.avatar_url(session["id"], session.get("avatar")),
        })

    @app.get("/dashboard/{guild_id}", response_class=HTMLResponse)
    async def dashboard_guild(request: Request, guild_id: int):
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        if not guild:
            raise HTTPException(status_code=404, detail="Bot is not in that server")

        level = await member_permission_level(guild, int(session["id"]))
        if level is None:
            raise HTTPException(status_code=403, detail="You are not a member of that server")

        return templates.TemplateResponse("player.html", {
            "request": request,
            "session": session,
            "avatar": oauth.avatar_url(session["id"], session.get("avatar")),
            "guild": {"id": str(guild.id), "name": guild.name,
                      "icon": guild.icon.url if guild.icon else None},
            "permission_level": level,
        })

    @app.get("/dashboard/{guild_id}/leaderboard", response_class=HTMLResponse)
    async def dashboard_leaderboard_page(request: Request, guild_id: int):
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        
        if not guild:
            raise HTTPException(status_code=404, detail="Bot is not in that server")

        level = await member_permission_level(guild, int(session["id"]))
        if level is None:
            raise HTTPException(status_code=403, detail="You are not a member of that server")

        return templates.TemplateResponse("leaderboard.html", {
            "request": request,
            "session": session,
            "avatar": oauth.avatar_url(session["id"], session.get("avatar")),
            "guild": {"id": str(guild.id), "name": guild.name,
                      "icon": guild.icon.url if guild.icon else None},
            "permission_level": level,
        })
    
    # ── JSON API ─────────────────────────────────────────────────

    @app.get("/api/guilds/{guild_id}/leaderboard")
    async def api_leaderboard(request: Request, guild_id: int):
        session = require_session(request)
        
        # Security check: Make sure they are in the server!
        guild = bot.get_guild(guild_id)
        if not guild or await member_permission_level(guild, int(session["id"])) is None:
            raise HTTPException(status_code=403, detail="Forbidden")

        # Fetch the top 5 songs from your database
        top_songs = await bot.db.get_top_songs(guild_id, limit=5)
        
        return {"top_songs": top_songs}


    @app.get("/api/me")
    async def api_me(request: Request):
        session = require_session(request)
        return {
            "id": session["id"],
            "username": session["username"],
            "avatar": oauth.avatar_url(session["id"], session.get("avatar")),
        }

    @app.get("/api/guilds")
    async def api_guilds(request: Request):
        session = require_session(request)
        user_id = int(session["id"])

        cache = app.state.guild_cache.get(session["id"])
        user_guild_ids = cache["guild_ids"] if cache else set()

        result = []
        for g in bot.guilds:
            if str(g.id) not in user_guild_ids:
                continue  # user isn't in this guild at all — skip without an API call

            level = await member_permission_level(g, user_id)
            if level is None:
                continue

            lavalink = getattr(bot, "lavalink", None)
            player = lavalink.player_manager.get(g.id) if lavalink else None
            is_playing = bool(player and player.is_connected and player.current)
            result.append({
                "id": str(g.id),
                "name": g.name,
                "icon": g.icon.url if g.icon else None,
                "member_count": g.member_count,
                "permission_level": level,
                "is_playing": is_playing,
            })
        return {"guilds": result}

    @app.get("/api/guilds/{guild_id}/player")
    async def api_player_state(request: Request, guild_id: int):
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        if not guild or await member_permission_level(guild, int(session["id"])) is None:
            raise HTTPException(status_code=403, detail="Forbidden")
        return player_to_dict(guild_id)

    @app.get("/api/guilds/{guild_id}/settings")
    async def api_get_settings(request: Request, guild_id: int):
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        level = await member_permission_level(guild, int(session["id"])) if guild else None
        if level is None:
            raise HTTPException(status_code=403, detail="Forbidden")
        prefix = await bot.db.get_prefix(guild_id) or "Rose_config_default"
        twentyfourseven = await bot.db.get_247(guild_id)
        return {
            "prefix": prefix if prefix != "Rose_config_default" else ">",
            "twentyfourseven": twentyfourseven,
            "can_edit": level in ("owner", "manager"),
        }

    @app.post("/api/guilds/{guild_id}/settings")
    async def api_set_settings(request: Request, guild_id: int):
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        level = await member_permission_level(guild, int(session["id"])) if guild else None
        if level not in ("owner", "manager"):
            raise HTTPException(status_code=403, detail="Requires Manage Server permission")

        body = await request.json()
        if "prefix" in body:
            new_prefix = str(body["prefix"])[:5]
            if new_prefix:
                await bot.db.set_prefix(guild_id, new_prefix)
        if "twentyfourseven" in body:
            await bot.db.set_247(guild_id, bool(body["twentyfourseven"]))

        return {"ok": True}

    # ── Player control actions ──────────────────────────────────
    # These call the SAME lavalink player_manager the Discord
    # commands use — a dashboard click and a `>skip` command do
    # the exact same thing under the hood.

    async def _require_player_control(request: Request, guild_id: int):
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        if not guild:
            raise HTTPException(status_code=404, detail="Guild not found")
        level = await member_permission_level(guild, int(session["id"]))
        if level is None:
            raise HTTPException(status_code=403, detail="Forbidden")

        lavalink = getattr(bot, "lavalink", None)
        player = lavalink.player_manager.get(guild_id) if lavalink else None
        if not player or not player.is_connected:
            raise HTTPException(status_code=409, detail="Bot is not connected to a voice channel")

        # Managers/owners can always control. Regular members can
        # control only if they're actually sitting in the same voice
        # channel as the bot — mirrors normal in-Discord expectations.
        if level == "member":
            member = guild.get_member(int(session["id"]))
            bot_vc = guild.voice_client
            in_same_vc = (
                member and member.voice and bot_vc
                and member.voice.channel and member.voice.channel.id == bot_vc.channel.id
            )
            if not in_same_vc:
                raise HTTPException(
                    status_code=403,
                    detail="Join the voice channel Rose is in to control playback"
                )
        return player

    @app.post("/api/guilds/{guild_id}/pause")
    async def api_pause(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        await player.set_pause(True)
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/resume")
    async def api_resume(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        await player.set_pause(False)
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/skip")
    async def api_skip(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        await player.skip()
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/stop")
    async def api_stop(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        player.queue.clear()
        await player.stop()
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/volume")
    async def api_volume(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        body = await request.json()
        vol = max(0, min(150, int(body.get("volume", 100))))
        await player.set_volume(vol)
        await broadcast_player_update(guild_id)
        return {"ok": True, "volume": vol}

    @app.post("/api/guilds/{guild_id}/loop")
    async def api_loop(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        body = await request.json()
        player.loop = bool(body.get("loop", False))
        await broadcast_player_update(guild_id)
        return {"ok": True, "loop": player.loop}

    @app.post("/api/guilds/{guild_id}/shuffle")
    async def api_shuffle(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        import random
        if player.queue:
            random.shuffle(player.queue)
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/autoplay")
    async def api_autoplay(request: Request, guild_id: int):
        await _require_player_control(request, guild_id)
        music_cog = bot.get_cog("Music")
        if not music_cog:
            raise HTTPException(status_code=500, detail="Music system unavailable")
        body = await request.json()
        music_cog.autoplay_states[guild_id] = bool(body.get("autoplay", False))
        await broadcast_player_update(guild_id)
        return {"ok": True, "autoplay": music_cog.autoplay_states[guild_id]}

    @app.post("/api/guilds/{guild_id}/previous")
    async def api_previous(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        music_cog = bot.get_cog("Music")
        if not music_cog:
            raise HTTPException(status_code=500, detail="Music system unavailable")
        ok = await music_cog.play_previous(guild_id)
        if not ok:
            raise HTTPException(status_code=409, detail="No previous track")
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/replay")
    async def api_replay(request: Request, guild_id: int):
        player = await _require_player_control(request, guild_id)
        if not player.current:
            raise HTTPException(status_code=409, detail="Nothing is playing")
        await player.seek(0)
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/queue/{index}/remove")
    async def api_queue_remove(request: Request, guild_id: int, index: int):
        player = await _require_player_control(request, guild_id)
        if 0 <= index < len(player.queue):
            player.queue.pop(index)
        await broadcast_player_update(guild_id)
        return {"ok": True}

    @app.post("/api/guilds/{guild_id}/play")
    async def api_play(request: Request, guild_id: int):
        """Queue a track from the dashboard search box. User must already
        be in a voice channel, same rule as the >play command."""
        session = require_session(request)
        guild = bot.get_guild(guild_id)
        if not guild:
            raise HTTPException(status_code=404, detail="Guild not found")
        if await member_permission_level(guild, int(session["id"])) is None:
            raise HTTPException(status_code=403, detail="Forbidden")

        member = guild.get_member(int(session["id"]))
        if not member or not member.voice or not member.voice.channel:
            raise HTTPException(status_code=400, detail="Join a voice channel in Discord first")

        body = await request.json()
        query = (body.get("query") or "").strip()
        if not query:
            raise HTTPException(status_code=400, detail="No search query given")

        music_cog = bot.get_cog("Music")
        if not music_cog:
            raise HTTPException(status_code=500, detail="Music system unavailable")

        ok, message = await music_cog.play_from_dashboard(guild, member, query)
        if not ok:
            raise HTTPException(status_code=400, detail=message)

        await broadcast_player_update(guild_id)
        return {"ok": True, "message": message}
    

    # ── WebSocket — live player sync ─────────────────────────────

    @app.websocket("/ws/{guild_id}")
    async def ws_player(websocket: WebSocket, guild_id: int):
        token = websocket.cookies.get("rose_session")
        session = oauth.read_session_token(token) if token else None
        if not session:
            await websocket.close(code=4001)
            return

        guild = bot.get_guild(guild_id)
        if not guild or await member_permission_level(guild, int(session["id"])) is None:
            await websocket.close(code=4003)
            return

        await websocket.accept()
        app.state.ws_clients.setdefault(guild_id, set()).add(websocket)

        try:
            # Send initial state immediately on connect
            await websocket.send_json({"type": "player_update", "data": player_to_dict(guild_id)})
            while True:
                # We don't expect incoming messages other than pings —
                # all control goes through the REST endpoints above.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            app.state.ws_clients.get(guild_id, set()).discard(websocket)

    # Make sure to actually return the app out of the function!
    return app


async def run_dashboard(bot):
    """Entry point called from main.py — runs the dashboard server
    as a background task on the bot's own event loop.

    Deliberately does NOT call server.serve() — that method wraps
    everything in uvicorn's capture_signals(), which installs its own
    SIGINT/SIGTERM handlers. Since this task shares a process (and event
    loop) with the Discord bot, those handlers fight with asyncio's/the
    bot's own shutdown handling: on a host-issued stop, both try to react
    to the same signal, and this task's resulting KeyboardInterrupt had
    nowhere to go because nothing was awaiting it — hence the
    "Task exception was never retrieved" warning during shutdown.

    Calling startup()/main_loop()/shutdown() directly is uvicorn's own
    documented pattern for embedding the server inside another
    application's event loop instead of owning the process' signals.
    """
    import uvicorn

    app = create_dashboard(bot)
    # Bind to 0.0.0.0 so the platform's reverse proxy (Railway/Render/Fly)
    # can actually reach this process from the public internet.
    config = uvicorn.Config(app, host=DASHBOARD_HOST, port=DASHBOARD_PORT, log_level="warning")
    server = uvicorn.Server(config)
    
    # --- UVICORN VERSION COMPATIBILITY FIX ---
    # Manually load the config and lifespan that Uvicorn normally handles in serve()
    if not config.loaded:
        config.load()
    server.lifespan = config.lifespan_class(config)
    # -----------------------------------------

    bot.dashboard_server = server  # so bot shutdown can trigger a clean stop
    print(f"  🌐 Dashboard starting on {DASHBOARD_HOST}:{DASHBOARD_PORT}")
    
    try:
        await server.startup()
        await server.main_loop()
    except asyncio.CancelledError:
        pass  # normal path when the bot cancels this task on shutdown
    except Exception as e:
        print(f" 🚨 DASHBOARD CRASHED: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if hasattr(server, "servers"):
            await server.shutdown()
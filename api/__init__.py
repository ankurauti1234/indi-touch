#!/usr/bin/env python3
# api/__init__.py — Flask application factory

import os
from flask import Flask, send_from_directory
from flask_cors import CORS


def create_app() -> Flask:
    # Serve static files from the parent directory (index.html, css/, js/, etc.)
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    app  = Flask(__name__, static_folder=root, static_url_path="")
    CORS(app)

    # ── Blueprints ─────────────────────────────────────────────────────────────
    from .wifi       import wifi_bp
    from .members    import members_bp
    from .guests     import guests_bp
    from .onboarding import onboarding_bp
    from .system     import system_bp
    from .notifications import notifications_bp
    from .wallpaper    import wallpaper_bp

    app.register_blueprint(wifi_bp,       url_prefix="/api/wifi")
    app.register_blueprint(members_bp,    url_prefix="/api/members")
    app.register_blueprint(guests_bp,     url_prefix="/api/guests")
    app.register_blueprint(onboarding_bp, url_prefix="/api/onboarding")
    app.register_blueprint(system_bp,     url_prefix="/api/system")
    app.register_blueprint(notifications_bp, url_prefix="/api/notifications")
    app.register_blueprint(wallpaper_bp,  url_prefix="/api/wallpaper")

    # ── Serve frontend ─────────────────────────────────────────────────────────
    @app.route("/")
    def index():
        return send_from_directory(root, "index.html")

    @app.route("/upload")
    def upload_page():
        return send_from_directory(root, "upload.html")

    @app.route("/<path:path>")
    def static_files(path):
        return send_from_directory(root, path)

    return app

#!/usr/bin/env python3
# api/wallpaper.py — Wallpaper upload, serve, reset

import os
import glob
import io
import qrcode
from PIL import Image, ImageOps
from flask import Blueprint, jsonify, request, send_from_directory, send_file
from .config import WALLPAPER_DIR, AVATAR_DIR
from .db import load_members_data, update_member_offline_avatar

wallpaper_bp = Blueprint("wallpaper", __name__)

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


def _get_current_wallpaper():
    """Return path to the current wallpaper file, or None."""
    for ext in ALLOWED_EXTENSIONS:
        matches = glob.glob(os.path.join(WALLPAPER_DIR, f"wallpaper.{ext}"))
        if matches:
            return matches[0]
    return None


@wallpaper_bp.route("/qr", methods=["GET"])
def wallpaper_qr():
    content = request.args.get("content", "")
    if not content:
        return jsonify({"error": "No content provided"}), 400

    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=2,
    )
    qr.add_data(content)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    
    buf = io.BytesIO()
    img.save(buf)
    buf.seek(0)
    
    return send_file(buf, mimetype="image/png")


def _clear_wallpapers():
    """Delete all wallpaper files."""
    for f in glob.glob(os.path.join(WALLPAPER_DIR, "wallpaper.*")):
        try:
            os.remove(f)
        except Exception:
            pass


# ── GET /api/wallpaper/status ─────────────────────────────────────────────────
@wallpaper_bp.route("/status", methods=["GET"])
def wallpaper_status():
    wp = _get_current_wallpaper()
    if wp:
        size_kb = round(os.path.getsize(wp) / 1024, 1)
        ext = os.path.splitext(wp)[1]
        return jsonify({
            "hasWallpaper": True,
            "url": f"/api/wallpaper/image?t={int(os.path.getmtime(wp))}",
            "sizeKB": size_kb,
            "ext": ext
        })
    return jsonify({"hasWallpaper": False, "url": None, "sizeKB": 0})


# ── GET /api/wallpaper/image ──────────────────────────────────────────────────
@wallpaper_bp.route("/image", methods=["GET"])
def wallpaper_image():
    wp = _get_current_wallpaper()
    if not wp:
        return jsonify({"error": "No wallpaper set"}), 404
    return send_from_directory(WALLPAPER_DIR, os.path.basename(wp))


# ── POST /api/wallpaper/upload ────────────────────────────────────────────────
@wallpaper_bp.route("/upload", methods=["POST"])
def wallpaper_upload():
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"success": False, "error": "Empty filename"}), 400

    # Check extension
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"success": False, "error": f"Unsupported format. Use JPG, PNG, or WebP."}), 400

    # Check size (read into memory to validate)
    try:
        # Open image with Pillow
        img = Image.open(file)
        
        # 1. Convert to RGB for JPEG compatibility
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
            
        # 2. Resize to max 1024x768 (or similar) while maintaining aspect ratio
        img.thumbnail((1024, 768), Image.Resampling.LANCZOS)
        
        # Delete previous wallpaper
        _clear_wallpapers()
        
        # Save new wallpaper as standardized JPEG for speed
        dest = os.path.join(WALLPAPER_DIR, "wallpaper.jpg")
        img.save(dest, "JPEG", quality=75, optimize=True)
        
        size_kb = round(os.path.getsize(dest) / 1024, 1)
        print(f"[WALLPAPER] Optimized: {size_kb}KB")

        return jsonify({"success": True, "url": f"/api/wallpaper/image?t={int(os.path.getmtime(dest))}"})

    except Exception as e:
        print(f"[WALLPAPER] Upload error: {e}")
        return jsonify({"success": False, "error": f"Image processing failed: {str(e)}"}), 500


# ── POST /api/wallpaper/reset ─────────────────────────────────────────────────
@wallpaper_bp.route("/reset", methods=["POST"])
def wallpaper_reset():
    _clear_wallpapers()
    return jsonify({"success": True})


# ── Member Avatars ────────────────────────────────────────────────────────────

@wallpaper_bp.route("/members", methods=["GET"])
def wallpaper_members():
    """Return list of members for the upload page."""
    data = load_members_data()
    members = data.get("members", [])
    
    # Check if all members have an offline avatar
    all_have = len(members) > 0 and all(m.get("offline_avatar") for m in members)
    
    return jsonify({
        "success": True, 
        "members": members,
        "all_have_avatars": all_have
    })


@wallpaper_bp.route("/upload_avatar", methods=["POST"])
def upload_avatar():
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file provided"}), 400
    
    member_code = request.form.get("member_code")
    if not member_code:
        return jsonify({"success": False, "error": "Member code required"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"success": False, "error": "Empty filename"}), 400

    # Extension and size check (Max 5MB for avatars)
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"success": False, "error": "Unsupported format."}), 400

    try:
        # Open image with Pillow
        img = Image.open(file)
        
        # 1. Convert to RGB if needed (handles PNG transparency to white or just removes alpha)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
            
        # 2. Square center-crop and resize to 200x200
        img = ImageOps.fit(img, (200, 200), Image.Resampling.LANCZOS)
        
        # 3. Save optimized image
        filename = f"avatar_{member_code}.jpg" # Standardize to jpg for consistency/size
        dest = os.path.join(AVATAR_DIR, filename)
        
        # Delete old versions
        for old in glob.glob(os.path.join(AVATAR_DIR, f"avatar_{member_code}.*")):
            try: os.remove(old)
            except: pass
            
        img.save(dest, "JPEG", quality=75, optimize=True)
        
        # Update DB
        update_member_offline_avatar(member_code, filename)
        
        size_kb = round(os.path.getsize(dest) / 1024, 1)
        print(f"[ONBOARD] Avatar optimized for {member_code}: {size_kb}KB")

        return jsonify({
            "success": True, 
            "url": f"/api/wallpaper/avatar_image?code={member_code}&t={int(os.path.getmtime(dest))}",
            "sizeKB": size_kb
        })

    except Exception as e:
        print(f"[ONBOARD] Optimization error: {e}")
        return jsonify({"success": False, "error": f"Image processing failed: {str(e)}"}), 500


@wallpaper_bp.route("/avatar_image", methods=["GET"])
def get_avatar_image():
    code = request.args.get("code")
    if not code:
        return jsonify({"error": "Member code required"}), 400
    
    # Find the file
    matches = glob.glob(os.path.join(AVATAR_DIR, f"avatar_{code}.*"))
    if not matches:
        return jsonify({"error": "No avatar set"}), 404
    
    return send_from_directory(AVATAR_DIR, os.path.basename(matches[0]))

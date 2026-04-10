#!/usr/bin/env python3
# api/avatar.py — Avatar upload, capture, QR generation

import os
import glob
import io
import qrcode
from PIL import Image, ImageOps
from flask import Blueprint, jsonify, request, send_from_directory, send_file
from .config import AVATAR_DIR
from .db import load_members_data, update_member_offline_avatar

avatar_bp = Blueprint("avatar", __name__)

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}

@avatar_bp.route("/qr", methods=["GET"])
def avatar_qr():
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

@avatar_bp.route("/members", methods=["GET"])
def get_members():
    """Return list of members for the avatar selection/upload."""
    data = load_members_data()
    return jsonify({
        "success": True, 
        "members": data.get("members", [])
    })

@avatar_bp.route("/upload", methods=["POST"])
def upload_avatar():
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file provided"}), 400
    
    member_code = request.form.get("member_code")
    if not member_code:
        return jsonify({"success": False, "error": "Member code required"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"success": False, "error": "Empty filename"}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"success": False, "error": "Unsupported format."}), 400

    try:
        img = Image.open(file)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
            
        # Square center-crop and resize
        img = ImageOps.fit(img, (200, 200), Image.Resampling.LANCZOS)
        
        filename = f"avatar_{member_code}.jpg"
        dest = os.path.join(AVATAR_DIR, filename)
        
        # Clear old versions
        for old in glob.glob(os.path.join(AVATAR_DIR, f"avatar_{member_code}.*")):
            try: os.remove(old)
            except: pass
            
        img.save(dest, "JPEG", quality=85, optimize=True)
        
        # Update Database reference
        update_member_offline_avatar(member_code, filename)
        
        return jsonify({
            "success": True, 
            "url": f"/api/avatar/image?code={member_code}&t={int(os.path.getmtime(dest))}"
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@avatar_bp.route("/image", methods=["GET"])
def get_avatar_image():
    code = request.args.get("code")
    if not code:
        return jsonify({"error": "Member code required"}), 400
    
    matches = glob.glob(os.path.join(AVATAR_DIR, f"avatar_{code}.*"))
    if not matches:
        return jsonify({"error": "No avatar set"}), 404
    
    return send_from_directory(AVATAR_DIR, os.path.basename(matches[0]))

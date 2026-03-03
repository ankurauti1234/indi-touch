#!/usr/bin/env python3
# api/settings_manager.py — File-based settings persistence

import json
import os
from .config import SETTINGS_FILE

# Default settings
DEFAULT_SETTINGS = {
    "language": "en",
    "location": "Yerevan",
    "remoteMode": False,
    "screenTimeout": 300000,
    "avatarStyle": "local",
    "reduceAnimations": False,
    "theme": "dark",
    "brightness": 255
}

def load_settings():
    """Load settings from JSON file. Returns defaults if file missing or corrupt."""
    if not os.path.exists(SETTINGS_FILE):
        return DEFAULT_SETTINGS.copy()
    
    try:
        with open(SETTINGS_FILE, "r") as f:
            data = json.load(f)
            # Merge with defaults to ensure all keys exist
            settings = DEFAULT_SETTINGS.copy()
            settings.update(data)
            return settings
    except Exception as e:
        print(f"[SETTINGS] Error loading {SETTINGS_FILE}: {e}")
        return DEFAULT_SETTINGS.copy()

def save_settings(settings_dict):
    """Save settings dictionary to JSON file."""
    try:
        # Load existing to merge (don't overwrite unrelated keys if any)
        current = load_settings()
        current.update(settings_dict)
        
        with open(SETTINGS_FILE, "w") as f:
            json.dump(current, f, indent=4)
        return True
    except Exception as e:
        print(f"[SETTINGS] Error saving {SETTINGS_FILE}: {e}")
        return False

def update_setting(key, value):
    """Update a single setting key."""
    return save_settings({key: value})

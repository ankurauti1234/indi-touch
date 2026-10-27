# api/absence.py
from flask import Blueprint, request, jsonify
import time

absence_bp = Blueprint('absence_bp', __name__)

# In-memory absence state (or persisted to local SQLite/JSON storage)
current_absence = None

@absence_bp.route('/api/household/absence', methods=['GET', 'POST', 'DELETE'])
def household_absence():
    global current_absence

    if request.method == 'GET':
        if current_absence and current_absence.get('end_time', 0) > time.time():
            return jsonify({'active': True, 'absence': current_absence}), 200
        return jsonify({'active': False, 'absence': None}), 200

    elif request.method == 'POST':
        data = request.get_json() or {}
        start_time = data.get('start_time', int(time.time()))
        end_time = data.get('end_time')

        if not end_time or end_time <= start_time:
            return jsonify({'success': False, 'error': 'Invalid date range'}), 400

        current_absence = {
            'start_time': start_time,
            'end_time': end_time,
            'activated_at': int(time.time())
        }

        # D-Bus event dispatch (Event Type 5: ABSENT)
        # from api.collector_service import send_event
        # send_event(5, current_absence)

        return jsonify({'success': True, 'absence': current_absence}), 200

    elif request.method == 'DELETE':
        current_absence = None
        # D-Bus event dispatch (Clear absent mode if needed)
        # send_event(5, {'start_time': 0, 'end_time': 0, 'cancelled': True})
        return jsonify({'success': True, 'message': 'Absence cancelled'}), 200
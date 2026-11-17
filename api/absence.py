# api/absence.py
from flask import Blueprint, request, jsonify
from datetime import datetime
from .collector_service import send_event

absence_bp = Blueprint('absence_bp', __name__)

# In-memory absence state ('present' | 'absent')
household_status = 'present'


@absence_bp.route('/absence', methods=['GET', 'POST', 'DELETE'])
def household_absence():
    global household_status

    if request.method == 'GET':
        is_absent = (household_status == 'absent')
        return jsonify({
            'active': is_absent,
            'status': household_status
        }), 200

    elif request.method == 'POST':
        data = request.get_json(force=True) or {}
        status = str(data.get('status', '')).strip().lower()

        if status not in ('absent', 'present'):
            return jsonify({'success': False, 'error': 'Invalid status. Expected "absent" or "present".'}), 400

        household_status = status

        if status == 'absent':
            # Event Type 5: Away Mode Activated
            send_event(5, {
                'action': 'activated',
                'status': 'absent',
                'activated_at': datetime.now().isoformat()
            })
        else:
            # Event Type 6: Away Mode Deactivated
            send_event(6, {
                'action': 'cancelled',
                'status': 'present',
                'cancelled_at': datetime.now().isoformat()
            })

        return jsonify({
            'success': True,
            'active': (household_status == 'absent'),
            'status': household_status
        }), 200

    elif request.method == 'DELETE':
        household_status = 'present'
        send_event(6, {
            'action': 'cancelled',
            'status': 'present',
            'cancelled_at': datetime.now().isoformat()
        })
        return jsonify({
            'success': True,
            'active': False,
            'status': 'present'
        }), 200
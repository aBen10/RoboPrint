from flask import Flask, render_template, Response, jsonify, request
import eventlet
# Only monkey patch what we need
eventlet.monkey_patch(socket=True, thread=False)  # Don't patch threading
from flask_socketio import SocketIO, emit
import cv2
from picamera2 import Picamera2
import socket
import threading
import time
import os
import logging
import atexit

# Configure logging
logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger(__name__)

class CameraManager:
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(CameraManager, cls).__new__(cls)
            cls._instance.picam2 = None
            try:
                cls._instance.initialize()
            except Exception as e:
                logger.error(f"Failed to initialize camera: {e}")
        return cls._instance

    def initialize(self):
        if self.picam2 is not None:
            return True

        try:
            logger.info("Initializing camera...")
            self.picam2 = Picamera2()
            config = self.picam2.create_preview_configuration(
                main={"format": 'RGB888', "size": (640, 480)}
            )
            self.picam2.configure(config)
            self.picam2.start()
            time.sleep(2)  # Warm-up time
            return True
        except Exception as e:
            logger.error(f"Camera initialization failed: {str(e)}")
            self.picam2 = None
            return False

    def cleanup(self):
        if self.picam2 is not None:
            try:
                logger.info("Cleaning up camera...")
                self.picam2.stop()
                self.picam2.close()
            except Exception as e:
                logger.error(f"Error cleaning up camera: {str(e)}")
            finally:
                self.picam2 = None

    def get_frame(self):
        if self.picam2 is None and not self.initialize():
            return None

        try:
            frame = self.picam2.capture_array()
            _, buffer = cv2.imencode('.jpg', frame)
            return buffer.tobytes()
        except Exception as e:
            logger.error(f"Error capturing frame: {str(e)}")
            return None

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Robot connection settings
ROBOT_IP = "192.168.0.100"
ROBOT_PORT = 10000

# Global variables
robot_socket = None
is_connected = False
last_command_time = 0
VELOCITY_TIMEOUT = 0.05

# Create single camera instance
camera = CameraManager()

def cleanup():
    camera.cleanup()
    if robot_socket:
        robot_socket.close()

atexit.register(cleanup)

def connect_to_robot():
    global robot_socket, is_connected
    try:
        robot_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        robot_socket.settimeout(0.1)  # Set timeout for receiving responses
        robot_socket.connect((ROBOT_IP, ROBOT_PORT))
        is_connected = True
        logger.info("Successfully connected to robot")
        
        # Initial setup commands
        send_command("ActivateRobot")
        send_command(f"SetVelTimeout({VELOCITY_TIMEOUT})")
        send_command("Home")
        
        # Start monitoring thread
        threading.Thread(target=monitor_robot_status, daemon=True).start()
        return True
    except Exception as e:
        logger.error(f"Failed to connect to robot: {str(e)}")
        is_connected = False
        return False

def monitor_robot_status():
    global is_connected, socketio
    while is_connected:
        try:
            if robot_socket:
                send_command("GetStatusRobot")
                response = robot_socket.recv(1024).decode()
                
                if "[2007]" in response:
                    try:
                        status_str = response.split('[2007][')[1].split(']')[0]
                        status_parts = status_str.split(',')
                        if len(status_parts) >= 4:
                            error_state = int(status_parts[3])
                            if error_state == 1:
                                logger.warning("Robot is in error state")
                                socketio.emit('robot_status', {'status': 'error'}, namespace='/')
                            else:
                                socketio.emit('robot_status', {'status': 'connected'}, namespace='/')
                    except Exception as e:
                        logger.error(f"Error parsing status: {str(e)}")
                
            time.sleep(1)
            
        except socket.timeout:
            continue
        except Exception as e:
            logger.error(f"Error in monitor_robot_status: {str(e)}")
            time.sleep(1)

def send_command(command):
    global robot_socket, last_command_time
    if not is_connected:
        logger.warning("Attempted to send command while disconnected")
        return False
    try:
        robot_socket.send((command + "\0").encode())
        last_command_time = time.time()
        return True
    except Exception as e:
        logger.error(f"Failed to send command: {str(e)}")
        return False

def generate_frames():
    while True:
        frame = camera.get_frame()
        if frame is not None:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
            time.sleep(0.5)
        else:
            time.sleep(0.5)

@app.route('/')
def index():
    try:
        return render_template('index.html')
    except Exception as e:
        logger.error(f"Failed to render template: {str(e)}")
        return f"Error loading template: {str(e)}", 500

@app.route('/video_feed')
def video_feed():
    if camera.picam2 is None and not camera.initialize():
        return "Camera not initialized", 500
    return Response(generate_frames(),
                   mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/connect', methods=['POST'])
def connect():
    success = connect_to_robot()
    return jsonify({"success": success})

@app.route('/reset_error', methods=['POST'])
def reset_error():
    if not is_connected:
        return jsonify({"success": False, "error": "Robot not connected"})
    
    try:
        # First send ResetError command
        success = send_command("ResetError")
        if success:
            # Then send ResumeMotion command
            success = send_command("ResumeMotion")
            logger.info("Reset error and resumed motion")
        return jsonify({"success": success})
    except Exception as e:
        logger.error(f"Error resetting robot: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/jog', methods=['POST'])
def jog():
    if not is_connected:
        return jsonify({"success": False, "error": "Robot not connected"})
    
    try:
        data = request.get_json()
        x = data.get('x', 0)
        y = data.get('y', 0)
        z = data.get('z', 0)
        
        # Convert to appropriate velocity values
        max_velocity = 20  # mm/s
        x_vel = float(x) * max_velocity
        y_vel = float(y) * max_velocity
        z_vel = float(z) * max_velocity
        
        success = send_command(f"MoveLinVelWrf({x_vel}, {y_vel}, {z_vel}, 0, 0, 0)")
        return jsonify({"success": success})
    except Exception as e:
        logger.error(f"Error in jog command: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/stop', methods=['POST'])
def stop():
    if not is_connected:
        return jsonify({"success": False, "error": "Robot not connected"})
    
    success = send_command("MoveLinVelWrf(0, 0, 0, 0, 0, 0)")
    return jsonify({"success": success})

@app.route('/gripper', methods=['POST'])
def gripper():
    if not is_connected:
        return jsonify({"success": False, "error": "Robot not connected"})
    
    try:
        data = request.get_json()
        action = data.get('action')
        
        if action == 'open':
            success = send_command("GripperOpen")
        elif action == 'close':
            success = send_command("GripperClose")
        else:
            return jsonify({"success": False, "error": "Invalid action"})
        
        return jsonify({"success": success})
    except Exception as e:
        logger.error(f"Error controlling gripper: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/update_settings', methods=['POST'])
def update_settings():
    if not is_connected:
        return jsonify({"success": False, "error": "Robot not connected"})
    
    try:
        data = request.get_json()
        timeout = data.get('timeout', 0.05)
        
        # Update velocity timeout
        VELOCITY_TIMEOUT = float(timeout)
        send_command(f"SetVelTimeout({VELOCITY_TIMEOUT})")
        
        return jsonify({"success": True})
    except Exception as e:
        logger.error(f"Error updating settings: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

if __name__ == '__main__':
    logger.info("Starting server...")
    try:
        # Run with eventlet WebSocket server
        eventlet.wsgi.server(eventlet.listen(('0.0.0.0', 5000)), app)
    except KeyboardInterrupt:
        logger.info("Shutting down gracefully...")
        cleanup()
    except Exception as e:
        logger.error(f"Server error: {e}")
        cleanup()
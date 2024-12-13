#!/usr/bin/env python3

from flask import Flask, render_template, jsonify, request
import eventlet
eventlet.monkey_patch(socket=True)
from flask_socketio import SocketIO, emit
import cv2
import numpy as np
from picamera2 import Picamera2
import socket
import threading
import base64
import time
import logging
import atexit
import netifaces
import colorama
from colorama import Fore, Style

# Initialize colorama for colored terminal output
colorama.init()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def get_ip_addresses():
    """Get all IP addresses for the device"""
    addresses = []
    try:
        interfaces = netifaces.interfaces()
        for iface in interfaces:
            if iface.startswith('lo'):
                continue
            addrs = netifaces.ifaddresses(iface)
            if netifaces.AF_INET in addrs:
                for addr in addrs[netifaces.AF_INET]:
                    ip = addr['addr']
                    if not ip.startswith('127.'):
                        addresses.append((iface, ip))
    except Exception as e:
        logger.error(f"Error getting IP addresses: {e}")
    return addresses

class Camera:
    def __init__(self):
        self.picam2 = None
        self.lock = eventlet.green.threading.Lock()
        self.frame_count = 0
        self.running = False
        self.last_frame = None
        self.capture_greenlet = None
        print(f"{Fore.CYAN}Initializing camera...{Style.RESET_ALL}")
        self.initialize()

    def initialize(self):
        with self.lock:
            try:
                if self.picam2:
                    self.cleanup()
                
                self.picam2 = Picamera2()
                config = self.picam2.create_still_configuration(
                    main={"size": (640, 480), "format": "RGB888"},
                    buffer_count=4
                )
                self.picam2.configure(config)
                print(f"{Fore.GREEN}Camera configuration successful{Style.RESET_ALL}")
                
                self.picam2.start()
                print(f"{Fore.GREEN}Camera started{Style.RESET_ALL}")
                
                eventlet.sleep(2)
                
                self.running = True
                if self.capture_greenlet:
                    self.capture_greenlet.kill()
                self.capture_greenlet = eventlet.spawn(self._capture_loop)
                
                return True
            except Exception as e:
                print(f"{Fore.RED}Camera initialization failed: {e}{Style.RESET_ALL}")
                self.cleanup()
                return False

    def _capture_loop(self):
        while self.running:
            try:
                frame = self.picam2.capture_array()
                _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                self.last_frame = base64.b64encode(buffer).decode('utf-8')
                
                self.frame_count += 1
                if self.frame_count % 300 == 0:
                    print(f"{Fore.CYAN}Captured frame {self.frame_count}{Style.RESET_ALL}")
                
                eventlet.sleep(0.033)
                
            except Exception as e:
                print(f"{Fore.RED}Frame capture error: {e}{Style.RESET_ALL}")
                eventlet.sleep(1)

    def get_frame(self):
        return self.last_frame

    def cleanup(self):
        self.running = False
        if self.capture_greenlet:
            self.capture_greenlet.kill()
            self.capture_greenlet = None
        
        with self.lock:
            if self.picam2:
                try:
                    self.picam2.stop()
                    self.picam2.close()
                except Exception as e:
                    print(f"{Fore.RED}Camera cleanup error: {e}{Style.RESET_ALL}")
                finally:
                    self.picam2 = None

class RobotConnection:
    def __init__(self, ip="192.168.0.100", port=10000):
        self.ip = ip
        self.port = port
        self.socket = None
        self.is_connected = False
        self.lock = eventlet.green.threading.Lock()
        self.monitor_greenlet = None
        # Settings
        self.velocity_timeout = 0.2  # seconds
        self.jog_velocity = 20.0      # mm/s
        self.settings_lock = eventlet.green.threading.Lock()

    def get_settings(self):
        with self.settings_lock:
            return {
                "velocity_timeout": self.velocity_timeout,
                "jog_velocity": self.jog_velocity
            }

    def update_settings(self, settings):
        with self.settings_lock:
            if 'velocity_timeout' in settings:
                self.velocity_timeout = float(settings['velocity_timeout'])
                self._send_command(f"SetVelTimeout({self.velocity_timeout})")
            
            if 'jog_velocity' in settings:
                self.jog_velocity = float(settings['jog_velocity'])

    def connect(self):
        with self.lock:
            try:
                if self.is_connected:
                    return True
                
                self.socket = eventlet.green.socket.socket(
                    eventlet.green.socket.AF_INET, 
                    eventlet.green.socket.SOCK_STREAM
                )
                self.socket.settimeout(0.1)
                self.socket.connect((self.ip, self.port))
                self.is_connected = True
                
                # Initialize robot
                self._send_command("ActivateRobot")
                self._send_command(f"SetVelTimeout({self.velocity_timeout})")
                self._send_command("Home")
                
                if self.monitor_greenlet:
                    self.monitor_greenlet.kill()
                self.monitor_greenlet = eventlet.spawn(self._monitor_status)
                
                print(f"{Fore.GREEN}Robot connected successfully{Style.RESET_ALL}")
                return True
            except Exception as e:
                print(f"{Fore.RED}Robot connection failed: {e}{Style.RESET_ALL}")
                self.is_connected = False
                if self.socket:
                    self.socket.close()
                    self.socket = None
                return False

    def _send_command(self, cmd):
        try:
            self.socket.send((cmd + "\0").encode())
            return True
        except Exception as e:
            print(f"{Fore.RED}Command failed: {e}{Style.RESET_ALL}")
            return False

    def send_command(self, cmd):
        with self.lock:
            if not self.is_connected:
                return False
            return self._send_command(cmd)

    def jog(self, x, y, z):
        with self.settings_lock:
            # Scale the input values (-1 to 1) by the current jog velocity
            x_vel = float(x) * self.jog_velocity
            y_vel = float(y) * self.jog_velocity
            z_vel = float(z) * self.jog_velocity
            
            return self.send_command(f"MoveLinVelWrf({x_vel}, {y_vel}, {z_vel}, 0, 0, 0)")

    def _monitor_status(self):
        while self.is_connected:
            try:
                if self.socket:
                    self._send_command("GetStatusRobot")
                    response = self.socket.recv(1024).decode()
                    if "[2007]" in response:
                        status_str = response.split('[2007][')[1].split(']')[0]
                        status_parts = status_str.split(',')
                        if len(status_parts) >= 4:
                            error_state = int(status_parts[3])
                            socketio.emit('robot_status', 
                                        {'status': 'error' if error_state == 1 else 'connected'})
            except eventlet.green.socket.timeout:
                pass
            except Exception as e:
                print(f"{Fore.YELLOW}Status monitoring error: {e}{Style.RESET_ALL}")
            eventlet.sleep(1)

    def cleanup(self):
        with self.lock:
            if self.monitor_greenlet:
                self.monitor_greenlet.kill()
                self.monitor_greenlet = None
            
            if self.socket:
                try:
                    self.socket.close()
                except Exception as e:
                    print(f"{Fore.RED}Socket cleanup error: {e}{Style.RESET_ALL}")
                finally:
                    self.socket = None
                    self.is_connected = False

app = Flask(__name__)
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins='*')
camera = None
robot = RobotConnection()

def stream_frames():
    print(f"{Fore.CYAN}Starting video stream{Style.RESET_ALL}")
    frame_count = 0
    start_time = time.time()
    
    while True:
        try:
            if camera and camera.running:
                frame = camera.get_frame()
                if frame:
                    socketio.emit('video_frame', {'frame': frame})
                    frame_count += 1
                    
                    if frame_count % 300 == 0:
                        elapsed = time.time() - start_time
                        fps = frame_count / elapsed
                        print(f"{Fore.CYAN}Streaming at {fps:.1f} FPS{Style.RESET_ALL}")
            
            eventlet.sleep(0.033)
        except Exception as e:
            print(f"{Fore.RED}Streaming error: {e}{Style.RESET_ALL}")
            eventlet.sleep(1)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/connect', methods=['POST'])
def connect():
    return jsonify({"success": robot.connect()})

@app.route('/reset_error', methods=['POST'])
def reset_error():
    if not robot.is_connected:
        return jsonify({"success": False, "error": "Robot not connected"})
    
    try:
        success = robot.send_command("ResetError")
        if success:
            success = robot.send_command("ResumeMotion")
            print(f"{Fore.GREEN}Reset error and resumed motion{Style.RESET_ALL}")
        return jsonify({"success": success})
    except Exception as e:
        print(f"{Fore.RED}Error resetting robot: {e}{Style.RESET_ALL}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/jog', methods=['POST'])
def jog():
    if not robot.is_connected:
        return jsonify({"success": False, "error": "Not connected"})
    
    try:
        data = request.get_json()
        success = robot.jog(
            data.get('x', 0),
            data.get('y', 0),
            data.get('z', 0)
        )
        return jsonify({"success": success})
    except Exception as e:
        print(f"{Fore.RED}Jog command error: {e}{Style.RESET_ALL}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/stop', methods=['POST'])
def stop():
    if not robot.is_connected:
        return jsonify({"success": False, "error": "Not connected"})
    success = robot.jog(0, 0, 0)
    return jsonify({"success": success})

@app.route('/gripper', methods=['POST'])
def gripper():
    if not robot.is_connected:
        return jsonify({"success": False, "error": "Not connected"})
    
    try:
        data = request.get_json()
        action = data.get('action')
        if action not in ['open', 'close']:
            return jsonify({"success": False, "error": "Invalid action"})
        
        cmd = "GripperOpen" if action == 'open' else "GripperClose"
        success = robot.send_command(cmd)
        return jsonify({"success": success})
    except Exception as e:
        print(f"{Fore.RED}Gripper command error: {e}{Style.RESET_ALL}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/settings', methods=['GET', 'POST'])
def settings():
    if request.method == 'GET':
        return jsonify(robot.get_settings())
    
    try:
        settings = request.get_json()
        robot.update_settings(settings)
        return jsonify({"success": True})
    except Exception as e:
        print(f"{Fore.RED}Settings update error: {e}{Style.RESET_ALL}")
        return jsonify({"success": False, "error": str(e)})

def cleanup():
    print(f"{Fore.YELLOW}Cleaning up resources...{Style.RESET_ALL}")
    if camera:
        camera.cleanup()
    robot.cleanup()

atexit.register(cleanup)

if __name__ == '__main__':
    try:
        print(f"\n{Fore.CYAN}{'='*50}")
        print("Robot Control Server")
        print(f"{'='*50}{Style.RESET_ALL}\n")

        addresses = get_ip_addresses()
        print(f"{Fore.GREEN}Server can be accessed at:{Style.RESET_ALL}")
        print(f"{Fore.YELLOW}Local access:{Style.RESET_ALL} http://localhost:5000")
        for iface, ip in addresses:
            print(f"{Fore.YELLOW}Network access ({iface}):{Style.RESET_ALL} http://{ip}:5000")
        print()

        camera = Camera()
        eventlet.spawn(stream_frames)
        print(f"{Fore.GREEN}Starting server...{Style.RESET_ALL}")
        socketio.run(
            app, 
            host='0.0.0.0',
            port=5000, 
            debug=False
        )
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Server shutdown requested{Style.RESET_ALL}")
    except Exception as e:
        print(f"\n{Fore.RED}Server error: {e}{Style.RESET_ALL}")
    finally:
        cleanup()
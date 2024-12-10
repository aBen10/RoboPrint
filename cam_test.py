from picamera2 import Picamera2
import time

picam2 = Picamera2()
config = picam2.create_preview_configuration()
picam2.configure(config)
picam2.start()
time.sleep(2)
frame = picam2.capture_array()
print(f"Frame shape: {frame.shape}, dtype: {frame.dtype}")
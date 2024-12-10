// Global variables
let socket;
let joystickActive = false;
let currentX = 0;
let currentY = 0;
let currentZ = 0;
let joggingInterval;
let connected = false;
let videoStreamActive = false;
let currentJogRequest = null;

const videoElement = document.getElementById('camera-feed');

function startVideoStream() {
    if (!videoStreamActive) {
        videoElement.src = '/video_feed';
        videoStreamActive = true;
    }
}

function stopVideoStream() {
    if (videoStreamActive) {
        videoElement.src = '';
        videoStreamActive = false;
    }
}

document.getElementById('toggle-video').addEventListener('click', function() {
    if (videoStreamActive) {
        stopVideoStream();
        this.textContent = 'Start Camera Feed';
    } else {
        startVideoStream();
        this.textContent = 'Stop Camera Feed';
    }
});

// Start video stream when page loads
window.addEventListener('load', startVideoStream);

// Clean up stream when page unloads
window.addEventListener('beforeunload', stopVideoStream);

document.getElementById('reset-error').addEventListener('click', resetError);

document.addEventListener('DOMContentLoaded', function() {
    // Connect to WebSocket
    socket = io();
    
    // Initialize UI elements
    initializeUI();
    
    // Setup WebSocket listeners
    setupWebSocketListeners();
    
    // Setup joystick and control listeners
    setupJoystickControls();
    
    // Setup button listeners
    setupButtonListeners();
});

document.getElementById('toggle-video').addEventListener('click', function() {
    const videoFeed = document.querySelector('.video-feed img');
    if (videoFeed.style.display === 'none') {
        videoFeed.style.display = 'block';
    } else {
        videoFeed.style.display = 'none';
    }
});

function initializeUI() {
    // Create error reset button if it doesn't exist
    let errorResetButton = document.getElementById('reset-error');
    if (!errorResetButton) {
        const controlsSection = document.querySelector('.controls');
        errorResetButton = document.createElement('button');
        errorResetButton.id = 'reset-error';
        errorResetButton.className = 'error-reset-btn';
        errorResetButton.textContent = 'Reset Error';
        errorResetButton.style.display = 'block';
        controlsSection.appendChild(errorResetButton);
    }

    // Initialize settings values
    document.getElementById('maxVelocity').value = 20;
    document.getElementById('timeout').value = 0.05;
}

function setupWebSocketListeners() {
    socket.on('robot_status', function(data) {
        const statusElement = document.getElementById('status');
        const errorResetButton = document.getElementById('reset-error');
        
        console.log('Received robot status:', data.status); // Debug log
        
        if (data.status === 'error') {
            statusElement.textContent = 'Error State';
            statusElement.style.color = 'red';
            if (errorResetButton) {
                errorResetButton.style.display = 'block';
            } else {
                console.error('Error reset button not found');
            }
        } else if (data.status === 'connected') {
            statusElement.textContent = 'Connected';
            statusElement.style.color = 'green';
            if (errorResetButton) {
                errorResetButton.style.display = 'none';
            }
        }
    });
}

function setupJoystickControls() {
    const joystick = document.getElementById('joystick');
    const knob = document.getElementById('knob');
    
    if (!joystick || !knob) return;
    
    let joystickRect = joystick.getBoundingClientRect();
    const maxDistance = (joystickRect.width / 2) * 0.8; // 80% of joystick radius
    
    function updateJoystickPosition(e) {
        if (!joystickActive) return;
        
        joystickRect = joystick.getBoundingClientRect();
        const centerX = joystickRect.left + joystickRect.width / 2;
        const centerY = joystickRect.top + joystickRect.height / 2;
        
        let deltaX = e.clientX - centerX;
        let deltaY = e.clientY - centerY;
        
        // Calculate distance from center
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        // Normalize if distance exceeds maxDistance
        if (distance > maxDistance) {
            deltaX = (deltaX / distance) * maxDistance;
            deltaY = (deltaY / distance) * maxDistance;
        }
        
        // Update knob position
        knob.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
        
        // Calculate normalized values (-1 to 1)
        currentX = deltaX / maxDistance;
        currentY = deltaY / maxDistance;
        
        // Send jog command if connected
        if (connected) {
            sendJogCommand(currentX, currentY, currentZ);
        }
    }
    
    joystick.addEventListener('mousedown', (e) => {
        joystickActive = true;
        updateJoystickPosition(e);
        document.addEventListener('mousemove', updateJoystickPosition);
    });
    
    document.addEventListener('mouseup', () => {
        if (joystickActive) {
            joystickActive = false;
            knob.style.transform = 'translate(0px, 0px)';
            currentX = 0;
            currentY = 0;
            document.removeEventListener('mousemove', updateJoystickPosition);
            if (connected) {
                sendJogCommand(0, 0, 0);
            }
        }
    });
}

function setupButtonListeners() {
    // Connect button
    document.getElementById('connect').addEventListener('click', connectRobot);
    
    // Error reset button
    document.getElementById('reset-error').addEventListener('click', resetError);
    
    // Stop button
    document.getElementById('stop').addEventListener('click', stopRobot);
    
    // Gripper controls
    document.getElementById('open-gripper').addEventListener('click', () => controlGripper('open'));
    document.getElementById('close-gripper').addEventListener('click', () => controlGripper('close'));
    
    // X-axis controls
    document.getElementById('x-plus').addEventListener('mousedown', () => startAxisJog('x', 1));
    document.getElementById('x-plus').addEventListener('mouseup', stopAxisJog);
    document.getElementById('x-minus').addEventListener('mousedown', () => startAxisJog('x', -1));
    document.getElementById('x-minus').addEventListener('mouseup', stopAxisJog);

    // Y-axis controls
    document.getElementById('y-plus').addEventListener('mousedown', () => startAxisJog('y', 1));
    document.getElementById('y-plus').addEventListener('mouseup', stopAxisJog);
    document.getElementById('y-minus').addEventListener('mousedown', () => startAxisJog('y', -1));
    document.getElementById('y-minus').addEventListener('mouseup', stopAxisJog);
    
    // Z-axis controls
    document.getElementById('z-up').addEventListener('mousedown', () => startAxisJog('z', 1));
    document.getElementById('z-up').addEventListener('mouseup', stopAxisJog);
    document.getElementById('z-down').addEventListener('mousedown', () => startAxisJog('z', -1));
    document.getElementById('z-down').addEventListener('mouseup', stopAxisJog);
    
    // Settings update
    document.getElementById('update-settings').addEventListener('click', updateSettings);
}

async function connectRobot() {
    try {
        const response = await fetch('/connect', {
            method: 'POST'
        });
        const data = await response.json();
        
        if (data.success) {
            connected = true;
            document.getElementById('status').textContent = 'Connected';
            document.getElementById('status').style.color = 'green';
        } else {
            document.getElementById('status').textContent = 'Connection Failed';
            document.getElementById('status').style.color = 'red';
        }
    } catch (error) {
        console.error('Error connecting to robot:', error);
        document.getElementById('status').textContent = 'Connection Error';
        document.getElementById('status').style.color = 'red';
    }
}

async function resetError() {
    try {
        console.log('Attempting to reset error'); // Debug log
        const response = await fetch('/reset_error', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        if (data.success) {
            console.log('Error reset successful');
            document.getElementById('status').textContent = 'Connected';
            document.getElementById('status').style.color = 'green';
            document.getElementById('reset-error').style.display = 'none';
        } else {
            console.error('Error reset failed:', data.error);
        }
    } catch (error) {
        console.error('Error resetting robot:', error);
    }
}

async function sendJogCommand(x, y, z) {
    try {
        // Cancel any pending jog request
        if (currentJogRequest) {
            currentJogRequest.abort();
        }

        // Create AbortController for this request
        const controller = new AbortController();
        currentJogRequest = controller;

        const response = await fetch('/jog', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ x, y, z }),
            signal: controller.signal
        });
        
        // Clear current request if completed
        if (currentJogRequest === controller) {
            currentJogRequest = null;
        }

        const data = await response.json();
        if (!data.success) {
            console.error('Jog command failed:', data.error);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Jog request cancelled');
        } else {
            console.error('Error sending jog command:', error);
        }
    }
}

function startZAxisJog(direction) {
    currentZ = direction;
    sendJogCommand(currentX, currentY, currentZ);
}

function stopZAxisJog() {
    currentZ = 0;
    sendJogCommand(currentX, currentY, currentZ);
}

function startAxisJog(axis, direction) {
    switch(axis) {
        case 'x':
            currentX = direction;
            break;
        case 'y':
            currentY = direction;
            break;
        case 'z':
            currentZ = direction;
            break;
    }
    sendJogCommand(currentX, currentY, currentZ);
}

function stopAxisJog() {
    // Reset all values when any button is released
    currentX = 0;
    currentY = 0;
    currentZ = 0;
    sendJogCommand(currentX, currentY, currentZ);
}

async function stopRobot() {
    try {
        const response = await fetch('/stop', {
            method: 'POST'
        });
        
        const data = await response.json();
        if (!data.success) {
            console.error('Stop command failed:', data.error);
        }
    } catch (error) {
        console.error('Error stopping robot:', error);
    }
}

async function controlGripper(action) {
    try {
        const response = await fetch('/gripper', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action })
        });
        
        const data = await response.json();
        if (!data.success) {
            console.error('Gripper control failed:', data.error);
        }
    } catch (error) {
        console.error('Error controlling gripper:', error);
    }
}

async function updateSettings() {
    try {
        const maxVelocity = document.getElementById('maxVelocity').value;
        const timeout = document.getElementById('timeout').value;
        
        const response = await fetch('/update_settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                maxVelocity: parseFloat(maxVelocity),
                timeout: parseFloat(timeout)
            })
        });
        
        const data = await response.json();
        if (!data.success) {
            console.error('Settings update failed:', data.error);
        }
    } catch (error) {
        console.error('Error updating settings:', error);
    }
}

// Update the cleanup function
window.addEventListener('beforeunload', function() {
    if (connected) {
        stopRobot();
    }
    stopVideoStream();
    if (currentJogRequest) {
        currentJogRequest.abort();
    }
});

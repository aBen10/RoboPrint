let socket = io();
let videoStreamActive = false;
let currentX = 0;
let currentY = 0;
let currentZ = 0;
let connected = false;

// Initialize DOM elements
const videoElement = document.getElementById('camera-feed');
const toggleButton = document.getElementById('toggle-video');
const loadingOverlay = document.querySelector('.loading-overlay');
const statusElement = document.getElementById('status');
const errorResetButton = document.getElementById('reset-error');

// Video stream control functions
function startVideoStream() {
    if (!videoStreamActive) {
        socket.emit('start_stream');
        videoStreamActive = true;
        toggleButton.textContent = 'Stop Camera Feed';
    }
}

function stopVideoStream() {
    if (videoStreamActive) {
        socket.emit('stop_stream');
        videoStreamActive = false;
        toggleButton.textContent = 'Start Camera Feed';
        videoElement.src = '';
    }
}

// Socket event handlers
socket.on('video_frame', function(data) {
    if (videoStreamActive) {
        videoElement.src = 'data:image/jpeg;base64,' + data.frame;
        if (loadingOverlay.style.display !== 'none') {
            loadingOverlay.style.display = 'none';
        }
    }
});

socket.on('robot_status', function(data) {
    if (data.status === 'error') {
        statusElement.textContent = 'Error State';
        statusElement.style.color = 'red';
        errorResetButton.style.display = 'block';
    } else if (data.status === 'connected') {
        statusElement.textContent = 'Connected';
        statusElement.style.color = 'green';
        errorResetButton.style.display = 'none';
    }
});

// Robot control functions
async function connectRobot() {
    try {
        const response = await fetch('/connect', {
            method: 'POST'
        });
        const data = await response.json();
        
        if (data.success) {
            connected = true;
            statusElement.textContent = 'Connected';
            statusElement.style.color = 'green';
        } else {
            statusElement.textContent = 'Connection Failed';
            statusElement.style.color = 'red';
        }
    } catch (error) {
        console.error('Error connecting to robot:', error);
        statusElement.textContent = 'Connection Error';
        statusElement.style.color = 'red';
    }
}

async function resetError() {
    try {
        const response = await fetch('/reset_error', {
            method: 'POST'
        });
        const data = await response.json();
        
        if (data.success) {
            statusElement.textContent = 'Connected';
            statusElement.style.color = 'green';
            errorResetButton.style.display = 'none';
        } else {
            console.error('Error reset failed:', data.error);
        }
    } catch (error) {
        console.error('Error resetting robot:', error);
    }
}

let currentJogRequest = null;

async function sendJogCommand(x, y, z) {
    try {
        if (currentJogRequest) {
            currentJogRequest.abort();
        }

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
    currentX = 0;
    currentY = 0;
    currentZ = 0;
    sendJogCommand(0, 0, 0);
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
        const timeout = document.getElementById('timeout').value;
        
        const response = await fetch('/update_settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
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

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {
    // Connect button
    document.getElementById('connect').addEventListener('click', connectRobot);
    
    // Error reset button
    document.getElementById('reset-error').addEventListener('click', resetError);
    
    // Stop button
    document.getElementById('stop').addEventListener('click', stopRobot);
    
    // Gripper controls
    document.getElementById('open-gripper').addEventListener('click', () => controlGripper('open'));
    document.getElementById('close-gripper').addEventListener('click', () => controlGripper('close'));
    
    // Axis controls
    document.getElementById('x-plus').addEventListener('mousedown', () => startAxisJog('x', 1));
    document.getElementById('x-plus').addEventListener('mouseup', stopAxisJog);
    document.getElementById('x-minus').addEventListener('mousedown', () => startAxisJog('x', -1));
    document.getElementById('x-minus').addEventListener('mouseup', stopAxisJog);

    document.getElementById('y-plus').addEventListener('mousedown', () => startAxisJog('y', 1));
    document.getElementById('y-plus').addEventListener('mouseup', stopAxisJog);
    document.getElementById('y-minus').addEventListener('mousedown', () => startAxisJog('y', -1));
    document.getElementById('y-minus').addEventListener('mouseup', stopAxisJog);

    document.getElementById('z-up').addEventListener('mousedown', () => startAxisJog('z', 1));
    document.getElementById('z-up').addEventListener('mouseup', stopAxisJog);
    document.getElementById('z-down').addEventListener('mousedown', () => startAxisJog('z', -1));
    document.getElementById('z-down').addEventListener('mouseup', stopAxisJog);
    
    // Settings update
    document.getElementById('update-settings').addEventListener('click', updateSettings);
    
    // Video toggle
    toggleButton.addEventListener('click', function() {
        if (videoStreamActive) {
            stopVideoStream();
        } else {
            startVideoStream();
        }
    });
});

// Start video stream when page loads
window.addEventListener('load', startVideoStream);

// Cleanup on page unload
window.addEventListener('beforeunload', function() {
    if (connected) {
        stopRobot();
    }
    stopVideoStream();
    if (currentJogRequest) {
        currentJogRequest.abort();
    }
});

// Socket setup
const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

// State variables
let frameCount = 0;
let lastFrameTime = Date.now();
let isRobotConnected = false;
let currentSettings = {
    jog_velocity: 20,
    velocity_timeout: 0.05
};
let activeJog = null;
const JOG_INTERVAL = 50;

// Prevent unwanted mobile behaviors
document.addEventListener('touchmove', function(e) {
    e.preventDefault();
}, { passive: false });

let lastTouchEnd = 0;
document.addEventListener('touchend', function(e) {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
        e.preventDefault();
    }
    lastTouchEnd = now;
}, false);

// Status management
function updateRobotStatus(status) {
    const statusDot = document.getElementById('robot-status-dot');
    const statusText = document.getElementById('robot-status-text');
    const errorPanel = document.getElementById('error-panel');
    
    statusDot.className = 'status-dot';
    isRobotConnected = status === 'connected';
    
    switch(status) {
        case 'connected':
            statusDot.classList.add('connected');
            statusText.textContent = 'Robot: Connected';
            errorPanel.classList.remove('visible');
            break;
        case 'error':
            statusDot.classList.add('error');
            statusText.textContent = 'Robot: Error';
            errorPanel.classList.add('visible');
            break;
        default:
            statusDot.classList.add('disconnected');
            statusText.textContent = 'Robot: Disconnected';
            errorPanel.classList.remove('visible');
    }
    toggleControlButtons(!isRobotConnected);
}

function updateStreamStatus(status) {
    const statusDot = document.getElementById('stream-status-dot');
    const statusText = document.getElementById('stream-status-text');
    
    statusDot.className = 'status-dot';
    
    switch(status) {
        case 'connected':
            statusDot.classList.add('connected');
            statusText.textContent = 'Camera: Connected';
            break;
        case 'error':
            statusDot.classList.add('error');
            statusText.textContent = 'Camera: Error';
            break;
        default:
            statusDot.classList.add('disconnected');
            statusText.textContent = 'Camera: Disconnected';
    }
}

// API request helper
async function sendRequest(endpoint, data = {}) {
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
        return await response.json();
    } catch (error) {
        console.error(`Request to ${endpoint} failed:`, error);
        return { success: false, error: error.message };
    }
}

// Jog controls
function startJog(axis, direction) {
    if (activeJog) {
        clearInterval(activeJog);
    }

    const jogData = {
        x: axis === 'x' ? direction : 0,
        y: axis === 'y' ? direction : 0,
        z: axis === 'z' ? direction : 0
    };

    // Send initial command
    sendRequest('/jog', jogData);

    // Set up interval for continuous jogging
    activeJog = setInterval(() => {
        sendRequest('/jog', jogData);
    }, JOG_INTERVAL);
}

function stopJog() {
    if (activeJog) {
        clearInterval(activeJog);
        activeJog = null;
        sendRequest('/jog', {x: 0, y: 0, z: 0});
    }
}

function setupJogControls() {
    const axes = ['x', 'y', 'z'];
    const directions = ['plus', 'minus'];

    axes.forEach(axis => {
        directions.forEach(dir => {
            const button = document.getElementById(`${axis}-${dir}`);
            const direction = dir === 'plus' ? 1 : -1;

            // Touch events
            button.addEventListener('touchstart', (e) => {
                e.preventDefault();
                button.classList.add('active');
                startJog(axis, direction);
            });

            button.addEventListener('touchend', (e) => {
                e.preventDefault();
                button.classList.remove('active');
                stopJog();
            });

            button.addEventListener('touchcancel', (e) => {
                e.preventDefault();
                button.classList.remove('active');
                stopJog();
            });

            // Mouse events
            button.addEventListener('mousedown', () => {
                startJog(axis, direction);
            });
            button.addEventListener('mouseup', stopJog);
            button.addEventListener('mouseleave', stopJog);
        });
    });
}

// Settings management
async function loadSettings() {
    try {
        const response = await fetch('/settings');
        const settings = await response.json();
        
        document.getElementById('jog-velocity').value = settings.jog_velocity;
        document.getElementById('velocity-timeout').value = settings.velocity_timeout;
        currentSettings = settings;
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

async function updateSettings() {
    const jogVelocity = parseFloat(document.getElementById('jog-velocity').value);
    const velocityTimeout = parseFloat(document.getElementById('velocity-timeout').value);

    if (isNaN(jogVelocity) || isNaN(velocityTimeout)) {
        alert('Please enter valid numbers for all settings');
        return;
    }

    const settings = {
        jog_velocity: jogVelocity,
        velocity_timeout: velocityTimeout
    };

    try {
        const response = await fetch('/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(settings)
        });

        const result = await response.json();
        if (result.success) {
            currentSettings = settings;
            alert('Settings updated successfully');
        } else {
            alert('Failed to update settings: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to update settings:', error);
        alert('Failed to update settings: ' + error.message);
    }
}

// Button state management
function toggleControlButtons(disabled) {
    const buttons = document.querySelectorAll('button:not(#connect):not(#reset-error):not(#retry-connection):not(#settings-toggle):not(#update-settings)');
    buttons.forEach(button => {
        button.disabled = disabled;
    });
    
    if (disabled) {
        stopJog();
    }
}

// Socket event handlers
socket.on('connect', () => {
    updateStreamStatus('connected');
    loadSettings();
});

socket.on('disconnect', () => {
    updateStreamStatus('disconnected');
    updateRobotStatus('disconnected');
});

socket.on('robot_status', function(data) {
    updateRobotStatus(data.status);
});

socket.on('video_frame', function(data) {
    frameCount++;
    const currentTime = Date.now();
    
    if (frameCount % 30 === 0) {
        const fps = Math.round(30000 / (currentTime - lastFrameTime));
        document.getElementById('stream-status').textContent = `${fps} FPS`;
        lastFrameTime = currentTime;
    }

    const img = new Image();
    img.onload = function() {
        document.getElementById('camera-feed').src = img.src;
    };
    img.src = 'data:image/jpeg;base64,' + data.frame;
});

// Event listeners setup
document.addEventListener('DOMContentLoaded', function() {
    // Settings panel toggle
    document.getElementById('settings-toggle').addEventListener('click', function() {
        const content = document.querySelector('.settings-content');
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        this.classList.toggle('open', isHidden);
    });

    // Connect button
    document.getElementById('connect').addEventListener('click', async () => {
        const button = document.getElementById('connect');
        button.disabled = true;
        const result = await sendRequest('/connect');
        button.disabled = false;
        
        if (!result.success) {
            alert('Failed to connect to robot: ' + (result.error || 'Unknown error'));
        }
    });

    // Error handling
    document.getElementById('reset-error').addEventListener('click', async () => {
        const result = await sendRequest('/reset_error');
        if (!result.success) {
            alert('Failed to reset error: ' + (result.error || 'Unknown error'));
        }
    });

    document.getElementById('retry-connection').addEventListener('click', () => {
        document.getElementById('connect').click();
    });

    // Settings
    document.getElementById('update-settings').addEventListener('click', updateSettings);

    // Gripper controls
    document.getElementById('open-gripper').addEventListener('click', () => {
        sendRequest('/gripper', { action: 'open' });
    });

    document.getElementById('close-gripper').addEventListener('click', () => {
        sendRequest('/gripper', { action: 'close' });
    });

    // Emergency stop
    document.getElementById('stop').addEventListener('click', () => {
        stopJog();  // Stop any active jogging
        sendRequest('/stop');
    });

    document.getElementById('home-joints').addEventListener('click', async () => {
        const result = await sendRequest('/home_joints');
        if (!result.success) {
            alert('Failed to home joints: ' + (result.error || 'Unknown error'));
        }
    });

    // Setup jog controls
    setupJogControls();

    // Safety: stop jogging if window loses focus or visibility
    window.addEventListener('blur', stopJog);
    window.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopJog();
        }
    });
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopJog();
    sendRequest('/stop');
});

// Initialize UI
toggleControlButtons(true);
loadSettings();
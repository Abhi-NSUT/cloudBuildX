require('dotenv').config();
const { io } = require('socket.io-client');

// Connect to your API
const socket = io('http://localhost:3000');

// Safely load the ID from your .env file instead of hardcoding it!
const TARGET_BUILD_ID = process.env.TARGET_BUILD_ID;

if (!TARGET_BUILD_ID) {
  console.error("FATAL: TARGET_BUILD_ID is not defined in your .env file!");
  process.exit(1);
}

socket.on('connect', () => {
  console.log('Connected to API!');
  socket.emit('subscribeToBuild', TARGET_BUILD_ID);
});

socket.on('build-log', (data) => {
  if (data.type === 'error') {
    console.error(`[ERROR] ${data.text}`);
  } else if (data.type === 'system') {
    console.log(`\n🤖 SYSTEM: ${data.text}`);
    if (data.text.includes('completed') || data.text.includes('failed')) {
        process.exit(0);
    }
  } else {
    console.log(`> ${data.text}`);
  }
});

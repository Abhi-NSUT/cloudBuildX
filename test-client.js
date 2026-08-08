const { io } = require('socket.io-client');

// Connect to your API
const socket = io('http://localhost:3000');

// Replace this with a real buildId from your database!
const TARGET_BUILD_ID = 'your-uuid-goes-here'; 

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

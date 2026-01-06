const fs = require('fs');
const path = '/home/jasan/.pm2/logs/01-Trading-Bot-out.log';
const stream = fs.createReadStream(path, { start: fs.statSync(path).size - 50000 });
let buffer = '';
stream.on('data', (chunk) => {
    buffer += chunk.toString();
});
stream.on('end', () => {
    const lines = buffer.split('\n');
    const debugLines = lines.filter(l => l.includes('debug_cancel_orders'));
    debugLines.forEach(l => console.log(l));
});

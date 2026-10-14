// Собирает оформление сайта (Tailwind) из index.html в vendor/app.css.
// Запускать после изменений в index.html: в папке tests «npm run css».
const fs = require('fs');
const path = require('path');
const { buildCss } = require('./run.js');
fs.writeFileSync(path.join(__dirname, '..', 'vendor', 'app.css'), buildCss());
console.log('vendor/app.css обновлён');

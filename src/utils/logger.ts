import fs from 'fs';
import path from 'path';

// Ruta del archivo de logs
const logDir = path.resolve(__dirname, '../../logs');
const logPath = path.join(logDir, 'history.log');

// Asegurar que el folder 'logs' exista
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

/**
 * Guarda un log en el archivo de historial con timestamp.
 * @param message Mensaje a guardar
 */
export function logHistory(message: string) {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}\n`;

  fs.appendFile(logPath, fullMessage, (err) => {
    if (err) {
      console.error('❌ Error escribiendo en el historial:', err);
    }
  });
}

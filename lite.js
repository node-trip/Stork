#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Получаем текущую директорию
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Глобальные переменные для всех модулей
global.DISABLE_DASHBOARD = true;
global.lastHeartbeat = Date.now();
global.updateHeartbeat = function() {
    global.lastHeartbeat = Date.now();
    return global.lastHeartbeat;
};

console.log('Запуск облегченной версии Stork Bot без графического интерфейса...');

// Импортируем основной модуль с предотвращением использования dashboard
try {
    import('./main.js').catch(err => {
        console.error(`Критическая ошибка при запуске: ${err.message}`);
        console.error(err.stack);
        
        // Записываем ошибку в лог
        try {
            const errorLogPath = path.join(__dirname, 'error.log');
            const errorMessage = `[${new Date().toISOString()}] Критическая ошибка при запуске lite.js: ${err.message}\n${err.stack}\n\n`;
            fs.appendFileSync(errorLogPath, errorMessage);
        } catch (e) {
            console.error('Не удалось записать лог ошибки:', e);
        }
        
        process.exit(1);
    });
} catch (error) {
    console.error(`Ошибка при импорте main.js: ${error.message}`);
    process.exit(1);
} 
#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Конфигурация мониторинга
const config = {
    // Максимальное время (в минутах) без обновления лог-файла, после которого считаем, что бот завис
    maxInactiveMinutes: 15,
    // Лог-файл бота
    logFile: path.join(__dirname, 'bot.log'),
    // Имя screen-сессии
    screenName: 'stork',
    // Команда для запуска бота
    startCommand: 'npm start',
    // Путь для хранения логов монитора
    monitorLogFile: path.join(__dirname, 'monitor.log')
};

// Функция для записи логов монитора
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    console.log(logMessage.trim());
    
    try {
        fs.appendFileSync(config.monitorLogFile, logMessage);
    } catch (error) {
        console.error(`Ошибка при записи лога монитора: ${error.message}`);
    }
}

// Функция для проверки, запущен ли бот
function isBotRunning() {
    try {
        // Проверяем наличие screen-сессии
        const screenOutput = execSync('screen -ls').toString();
        return screenOutput.includes(config.screenName);
    } catch (error) {
        log(`Ошибка при проверке screen-сессий: ${error.message}`);
        return false;
    }
}

// Функция для проверки активности бота
function isBotActive() {
    try {
        if (!fs.existsSync(config.logFile)) {
            log(`Лог-файл бота не найден: ${config.logFile}`);
            return false;
        }
        
        const stats = fs.statSync(config.logFile);
        const lastModified = stats.mtime;
        const now = new Date();
        
        // Разница в минутах между текущим временем и временем последнего изменения лог-файла
        const diffMinutes = (now - lastModified) / (1000 * 60);
        
        if (diffMinutes > config.maxInactiveMinutes) {
            log(`Бот неактивен более ${diffMinutes.toFixed(2)} минут (максимум: ${config.maxInactiveMinutes} минут)`);
            return false;
        }
        
        return true;
    } catch (error) {
        log(`Ошибка при проверке активности бота: ${error.message}`);
        return false;
    }
}

// Функция для запуска бота
function startBot() {
    try {
        log('Запуск бота...');
        
        // Если screen-сессия уже существует, удаляем её
        if (isBotRunning()) {
            log('Удаление существующей screen-сессии...');
            execSync(`screen -S ${config.screenName} -X quit`);
        }
        
        // Запускаем новую screen-сессию с ботом
        execSync(`cd ${__dirname} && screen -dmS ${config.screenName} ${config.startCommand}`);
        
        log('Бот успешно запущен в screen-сессии');
        return true;
    } catch (error) {
        log(`Ошибка при запуске бота: ${error.message}`);
        return false;
    }
}

// Главная функция мониторинга
function monitor() {
    log('Запуск мониторинга...');
    
    const isRunning = isBotRunning();
    log(`Статус screen-сессии: ${isRunning ? 'активна' : 'не найдена'}`);
    
    if (!isRunning) {
        log('Бот не запущен. Запускаем...');
        startBot();
        return;
    }
    
    const isActive = isBotActive();
    log(`Статус активности бота: ${isActive ? 'активен' : 'неактивен'}`);
    
    if (!isActive) {
        log('Бот завис или неактивен. Перезапускаем...');
        startBot();
    } else {
        log('Бот работает нормально.');
    }
}

// Запускаем мониторинг
monitor(); 
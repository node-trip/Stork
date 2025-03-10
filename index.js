#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { getBannerText } from './banner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Проверяем аргументы командной строки
const args = process.argv.slice(2);
const hasSetupArg = args.includes('--setup') || args.includes('-s');
const hasRunArg = args.includes('--run') || args.includes('-r');
const hasHelpArg = args.includes('--help') || args.includes('-h');

// Функция для проверки необходимых файлов
function checkRequiredFiles() {
  const requiredFiles = [
    { path: 'config.json', defaultContent: {} },
    { path: 'accounts.txt', defaultContent: '' },
    { path: 'proxies.txt', defaultContent: '' },
    { path: 'tokens.json', defaultContent: {} }
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(__dirname, file.path);
    if (!fs.existsSync(filePath)) {
      console.log(chalk.yellow(`Создание файла ${file.path}...`));
      
      // Создаем содержимое файла по умолчанию
      let content = '';
      if (typeof file.defaultContent === 'object') {
        content = JSON.stringify(file.defaultContent, null, 2);
      } else {
        content = file.defaultContent;
      }
      
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
}

// Функция для отображения справки
function showHelp() {
  console.log(chalk.blue(getBannerText()));
  console.log('Использование:');
  console.log('  npm start            - Запуск бота с интерактивной настройкой');
  console.log('  npm start -- --setup - Запуск только режима настройки');
  console.log('  npm start -- --run   - Запуск бота без настройки');
  console.log('  npm start -- --help  - Показать эту справку');
  console.log('\nПараметры:');
  console.log('  --setup, -s         - Запустить мастер настройки');
  console.log('  --run, -r           - Запустить бота без настройки');
  console.log('  --help, -h          - Показать справку');
  process.exit(0);
}

// Главная функция запуска приложения
async function main() {
  console.log(chalk.blue(getBannerText()));
  
  // Проверяем и создаем необходимые файлы
  checkRequiredFiles();
  
  // Если указан флаг help, показываем справку и выходим
  if (hasHelpArg) {
    showHelp();
    return;
  }
  
  // Запуск в зависимости от аргументов
  if (hasRunArg) {
    console.log(chalk.green('Запуск бота без настройки...'));
    import('./main.js').catch(err => {
      console.error('Ошибка при запуске бота:', err);
      process.exit(1);
    });
  } else if (hasSetupArg) {
    console.log(chalk.green('Запуск мастера настройки...'));
    import('./setup.js').catch(err => {
      console.error('Ошибка при запуске мастера настройки:', err);
      process.exit(1);
    });
  } else {
    // По умолчанию запускаем мастер настройки
    console.log(chalk.green('Запуск мастера настройки...'));
    import('./setup.js').catch(err => {
      console.error('Ошибка при запуске мастера настройки:', err);
      process.exit(1);
    });
  }
}

// Запускаем приложение
main().catch(err => {
  console.error('Произошла ошибка:', err);
  process.exit(1); 
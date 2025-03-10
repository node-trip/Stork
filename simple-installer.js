#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import readline from 'readline';
import { getBannerText } from './banner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Создаем интерфейс readline
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Функция для асинхронного запроса данных у пользователя
function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Функция для проверки существования файла
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (err) {
    return false;
  }
}

// Функция для сохранения конфигурации
function saveConfig(config) {
  const configPath = path.join(__dirname, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(chalk.green('✓ Конфигурация сохранена'));
}

// Функция для быстрой настройки
async function quickSetup() {
  console.log(chalk.blue(getBannerText()));
  console.log(chalk.green('Быстрая настройка Stork Bot\n'));
  
  // Создаем структуру конфигурации
  const config = {
    cognito: {
      region: "ap-northeast-1",
      clientId: "5msns4n49hmg3dftp2tp1t2iuh",
      userPoolId: "ap-northeast-1_M22I44OpC"
    },
    stork: {
      intervalSeconds: 60
    },
    threads: {
      maxWorkers: 10
    }
  };
  
  // Запрашиваем базовые настройки
  console.log(chalk.yellow('\nНастройка параметров:'));
  
  const intervalStr = await question('Введите интервал в секундах между валидациями [60]: ');
  if (intervalStr.trim() !== '') {
    const interval = parseInt(intervalStr);
    if (!isNaN(interval) && interval > 0) {
      config.stork.intervalSeconds = interval;
    }
  }
  
  const workersStr = await question('Введите максимальное количество потоков [10]: ');
  if (workersStr.trim() !== '') {
    const workers = parseInt(workersStr);
    if (!isNaN(workers) && workers > 0) {
      config.threads.maxWorkers = workers;
    }
  }
  
  // Сохраняем конфигурацию
  saveConfig(config);
  
  // Запрашиваем данные для аккаунтов
  console.log(chalk.yellow('\nНастройка аккаунтов:'));
  const accountsPath = path.join(__dirname, 'accounts.txt');
  let accounts = [];
  
  if (fileExists(accountsPath)) {
    const existingAccounts = fs.readFileSync(accountsPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '');
    
    if (existingAccounts.length > 0) {
      console.log(chalk.gray(`Найдено ${existingAccounts.length} существующих аккаунтов.`));
      const clearAccounts = await question('Очистить существующие аккаунты? (да/нет) [нет]: ');
      if (clearAccounts.toLowerCase() !== 'да') {
        accounts = existingAccounts;
      }
    }
  }
  
  while (true) {
    const addAccount = await question('Добавить аккаунт? (да/нет) [да]: ');
    if (addAccount.toLowerCase() === 'нет') break;
    
    const email = await question('Введите email: ');
    if (!email.trim()) {
      console.log(chalk.red('Email не может быть пустым.'));
      continue;
    }
    
    const password = await question('Введите пароль: ');
    if (!password.trim()) {
      console.log(chalk.red('Пароль не может быть пустым.'));
      continue;
    }
    
    accounts.push(`${email}|${password}`);
    console.log(chalk.green('✓ Аккаунт добавлен'));
  }
  
  // Сохраняем аккаунты
  fs.writeFileSync(accountsPath, accounts.join('\n'), 'utf8');
  console.log(chalk.green(`✓ Сохранено ${accounts.length} аккаунтов`));
  
  // Запрашиваем данные для прокси
  console.log(chalk.yellow('\nНастройка прокси:'));
  const proxiesPath = path.join(__dirname, 'proxies.txt');
  let proxies = [];
  
  if (fileExists(proxiesPath)) {
    const existingProxies = fs.readFileSync(proxiesPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '');
    
    if (existingProxies.length > 0) {
      console.log(chalk.gray(`Найдено ${existingProxies.length} существующих прокси.`));
      const clearProxies = await question('Очистить существующие прокси? (да/нет) [нет]: ');
      if (clearProxies.toLowerCase() !== 'да') {
        proxies = existingProxies;
      }
    }
  }
  
  while (true) {
    const addProxy = await question('Добавить прокси? (да/нет) [да]: ');
    if (addProxy.toLowerCase() === 'нет') break;
    
    console.log('Выберите тип прокси:');
    console.log('1. HTTP/HTTPS');
    console.log('2. SOCKS');
    
    const proxyType = await question('Выберите тип (1/2): ');
    let proxyStr = '';
    
    if (proxyType === '1') {
      proxyStr = await question('Введите HTTP/HTTPS прокси (формат: http://user:pass@ip:port): ');
      if (!proxyStr.startsWith('http://') && !proxyStr.startsWith('https://')) {
        console.log(chalk.yellow('Префикс протокола не указан, добавляю http://'));
        proxyStr = 'http://' + proxyStr;
      }
    } else if (proxyType === '2') {
      proxyStr = await question('Введите SOCKS прокси (формат: socks://user:pass@ip:port): ');
      if (!proxyStr.startsWith('socks://') && !proxyStr.startsWith('socks5://')) {
        console.log(chalk.yellow('Префикс протокола не указан, добавляю socks5://'));
        proxyStr = 'socks5://' + proxyStr;
      }
    } else {
      console.log(chalk.red('Неверный тип прокси.'));
      continue;
    }
    
    if (!proxyStr.trim()) {
      console.log(chalk.red('Прокси не может быть пустым.'));
      continue;
    }
    
    proxies.push(proxyStr);
    console.log(chalk.green('✓ Прокси добавлен'));
  }
  
  // Сохраняем прокси
  fs.writeFileSync(proxiesPath, proxies.join('\n'), 'utf8');
  console.log(chalk.green(`✓ Сохранено ${proxies.length} прокси`));
  
  // Всё готово
  console.log(chalk.green('\n✓ Настройка завершена!'));
  console.log(chalk.blue('Для запуска бота выполните команду:'));
  console.log(chalk.white('npm start'));
  
  rl.close();
}

// Запускаем быструю настройку
quickSetup().catch(err => {
  console.error('Произошла ошибка:', err);
  rl.close();
  process.exit(1);
}); 
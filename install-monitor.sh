#!/bin/bash

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # Без цвета

# Получаем текущий каталог скрипта
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Функция для вывода сообщений
print_message() {
  echo -e "${BLUE}[STORK MONITOR]${NC} $1"
}

print_success() {
  echo -e "${GREEN}[УСПЕХ]${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}[ВНИМАНИЕ]${NC} $1"
}

print_error() {
  echo -e "${RED}[ОШИБКА]${NC} $1"
}

# Проверяем наличие Node.js
if ! command -v node &> /dev/null; then
    print_error "Node.js не найден. Пожалуйста, установите Node.js."
    exit 1
fi

# Проверяем наличие screen
if ! command -v screen &> /dev/null; then
    print_error "Утилита screen не найдена. Пожалуйста, установите screen."
    exit 1
fi

# Проверяем наличие crontab
if ! command -v crontab &> /dev/null; then
    print_error "Утилита crontab не найдена. Пожалуйста, установите cron."
    exit 1
fi

# Устанавливаем разрешения на выполнение для скрипта мониторинга
chmod +x "${SCRIPT_DIR}/monitor.js"

print_message "Настройка мониторинга для Stork Bot"

# Добавляем задание в crontab
cat > /tmp/stork_cron << EOL
# Проверка Stork Bot каждые 15 минут
*/15 * * * * cd ${SCRIPT_DIR} && /usr/bin/env node ${SCRIPT_DIR}/monitor.js
EOL

print_message "Проверка существующих заданий crontab..."
EXISTING_CRON=$(crontab -l 2>/dev/null || echo "")

if echo "$EXISTING_CRON" | grep -q "monitor.js"; then
    print_warning "Задание мониторинга уже существует в crontab. Обновление..."
    # Удаляем существующие задания мониторинга
    UPDATED_CRON=$(echo "$EXISTING_CRON" | grep -v "monitor.js")
    echo "$UPDATED_CRON" > /tmp/existing_cron
    cat /tmp/stork_cron >> /tmp/existing_cron
    crontab /tmp/existing_cron
else
    # Добавляем новое задание
    if [ -z "$EXISTING_CRON" ]; then
        crontab /tmp/stork_cron
    else
        echo "$EXISTING_CRON" > /tmp/existing_cron
        cat /tmp/stork_cron >> /tmp/existing_cron
        crontab /tmp/existing_cron
    fi
fi

# Чистим временные файлы
rm -f /tmp/stork_cron /tmp/existing_cron

print_success "Мониторинг настроен! Stork Bot будет проверяться каждые 15 минут."
print_message "Если бот не работает или завис, он будет автоматически перезапущен."

# Запускаем скрипт мониторинга первый раз
print_message "Запуск мониторинга прямо сейчас..."
node "${SCRIPT_DIR}/monitor.js"

print_success "Установка мониторинга завершена!"
print_message "Вы можете проверить статус cron задания с помощью команды: crontab -l" 
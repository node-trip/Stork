#!/bin/bash

# Скрипт для установки и запуска Stork Bot на сервере
# Запустите этот скрипт на вашем сервере

# Проверяем наличие curl
if ! command -v curl &> /dev/null; then
    echo "Утилита curl не найдена. Установка curl..."
    
    # Определяем дистрибутив Linux
    if [ -f /etc/debian_version ]; then
        # Debian/Ubuntu
        apt-get update
        apt-get install -y curl
    elif [ -f /etc/redhat-release ]; then
        # CentOS/RHEL
        yum install -y curl
    else
        echo "Не удалось определить дистрибутив. Пожалуйста, установите curl вручную."
        exit 1
    fi
fi

# Загружаем и запускаем установщик
echo "Загрузка и запуск установщика Stork Bot..."
curl -s https://raw.githubusercontent.com/node-trip/Stork/main/install.sh -o install.sh
chmod +x install.sh
./install.sh

# Удаляем временный файл установщика
rm -f install.sh

echo "Скрипт запуска Stork Bot выполнен." 
# Website-Image (PHP 8.2 + Apache). Nutzt die native "mongodb"-PECL-Extension
# (MongoDB\Driver\Manager direkt, kein Composer-Package noetig -- verifiziert
# gegen api.php/admin-api.php/admin-login.php). Aufruf: docker build -f
# website/Dockerfile -t tm-website website
FROM php:8.2-apache

RUN apt-get update \
    && apt-get install -y --no-install-recommends autoconf pkg-config libssl-dev \
    && pecl install mongodb \
    && docker-php-ext-enable mongodb \
    && apt-get purge -y autoconf pkg-config \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY . /var/www/html/

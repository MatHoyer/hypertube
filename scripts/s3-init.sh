until ./rc alias set local http://s3:9000 ${S3_ROOT_USER} ${S3_ROOT_PASSWORD}; do sleep 1; done
./rc mb -p local/movies || true
sed "s|__CLIENT_URL__|${CLIENT_URL}|g" /s3-cors-config.xml > /tmp/cors.xml
./rc bucket cors set local/movies /tmp/cors.xml
./rc mb -p local/images || true
./rc anonymous set download local/images

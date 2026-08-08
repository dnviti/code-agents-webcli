@ECHO off
node -e "process.stdout.write(JSON.stringify(process.argv.slice(2)))" placeholder %*

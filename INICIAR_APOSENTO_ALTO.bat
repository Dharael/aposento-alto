@echo off
title Aposento Alto - Comunidad Cristiana
cd /d "%~dp0"
echo ==================================================
echo    APOSENTO ALTO - Comunidad Cristiana
echo ==================================================
echo.
echo  1) Encendiendo el servidor...
start "Aposento Alto - Servidor (no cerrar)" cmd /k node server.js
timeout /t 3 >nul
echo  2) Abriendo la app en tu navegador...
start "" http://localhost:4321
echo  3) Creando el LINK PUBLICO para telefonos e iPhone...
echo.
echo  ================================================
echo   Busca el link  https://....trycloudflare.com
echo   en la ventana "LINK PUBLICO" que se abrira.
echo   Ese es el link que compartes con tu mama y hermanos.
echo  ================================================
echo.
start "Aposento Alto - LINK PUBLICO (aqui sale el link)" "C:\Users\adan_\Documents\domino_server\cloudflared.exe" tunnel --url http://localhost:4321
echo.
echo  Listo. Deja TODAS las ventanas abiertas mientras usen la app.
echo  Puedes cerrar solo esta ventana.
pause >nul

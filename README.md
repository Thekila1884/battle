# Battleweb

Prototipo web multijugador táctico por rondas simultáneas. Incluye lobby con códigos de sala, hasta ocho pilotos, selección de modo y arena 9×9.

## Desarrollo

1. Instala Node.js 20 o posterior.
2. Ejecuta `npm install`.
3. Crea un proyecto en Firebase, activa **Authentication → Anonymous** y crea una instancia de **Realtime Database**.
4. Copia la configuración de tu aplicación web a `.env.local`. Usa la URL exacta mostrada en **Realtime Database → Data**; `VITE_FIREBASE_DATABASE_URL` puede variar por región y nombre de instancia. No asumas que termina en `firebaseio.com`.
5. Si cambias variables mientras Vite está ejecutándose, reinicia `npm run dev`.
6. Inicia con `npm run dev`.

No publiques el archivo `.env.local`. Las variables `VITE_*` se incluyen en el bundle del navegador; son configuración pública, no claves de administrador.

## Modos

Los modos viven en `src/game/modes/` y comparten el motor de `src/game/engine.js`. La primera iteración tiene lobby y resolución en línea para Clásico y Tormenta; los demás módulos definen el catálogo para ampliar sus reglas en iteraciones posteriores.

## Firebase y despliegue

La resolución de rondas se ejecuta en el navegador del anfitrión, por lo que este prototipo es apropiado para partidas casuales con personas de confianza, no para torneos ni para protegerse de trampas. Para producción, mueve la validación y resolución a Cloud Functions y limita las escrituras mediante reglas de Realtime Database. No habilites acceso público de lectura o escritura.

**Importante:** durante una prueba, la base configurada permitió lecturas y borrados REST sin autenticar. Antes de volver a usarla, publica [database.rules.json](./database.rules.json) desde **Realtime Database → Rules** y verifica que las peticiones sin autenticar sean rechazadas. Estas reglas son una barrera mínima: como la app usa cuentas anónimas, cualquier visitante puede autenticarse y modificar una sala si conoce su código. Para uso público, aplica reglas que limiten cada sala a sus participantes y mueve la resolución autoritativa al servidor.

Revisa y prueba las reglas en Firebase Emulator antes de desplegar; el esquema puede cambiar mientras evoluciona el prototipo.

## Comandos

- `npm run dev`: servidor de desarrollo.
- `npm run build`: bundle de producción.
- `npm test`: pruebas del motor.

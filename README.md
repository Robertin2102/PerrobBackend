# Backend de Perrob / Salario

API REST independiente de Unity para guardar resultados de partidas y consultar telemetría. Usa Node.js 20+ y PostgreSQL. La tabla de partidas reales (`live`) está separada de los datos controlados de evaluación (`seed`).

## Qué guarda cada partida

- `matchId` (UUID): identifica una partida y evita que un reintento la cuente dos veces.
- `roomCode`, hora de inicio, hora de fin y duración.
- Por cada uno de los dos jugadores: `playerId`, slot 0/1, documentos entregados, bolas de papel lanzadas, impactos acertados y recibidos, eliminaciones (`knockouts`), veces eliminado (`deaths`) y segundos acumulados vivo (`survivalSeconds`).
- El servidor calcula victoria, derrota o empate a partir de **documentos entregados**, que es la regla actual del juego. Una eliminación es el evento de quedar sin energía; el jugador reaparece después. Por eso aquí `deaths` representa eliminaciones sufridas, no abandonar la partida.

No se guardan nombres, correos ni posiciones por fotograma. `playerId` debe ser un identificador estable si quieres estadísticas por jugador; para pruebas basta `empleado-01` y `empleado-02`.

## Endpoints

| Método y ruta | Función | Acceso |
| --- | --- | --- |
| `GET /health` | Comprueba servidor y PostgreSQL | Público |
| `GET /api/test/telemetry` | Métricas agregadas: Win Rate, KDR, supervivencia, impactos y documentos | Público |
| `POST /api/test/seed` | Reemplaza sólo las partidas de prueba con 100–1,000 registros | `ADMIN_TOKEN` |
| `POST /api/matches` | Guarda una partida real con sus dos jugadores | `MATCH_INGEST_TOKEN` |

`GET /api/test/telemetry` acepta `source=all|seed|live` y `playerId=...`. Sin filtros agrupa **resultados de jugadores**: una partida aporta dos resultados. `winRatePercent = victorias / resultados de jugadores × 100`; para el porcentaje de una persona usa `playerId`. `kdr = eliminaciones / max(1, veces eliminado)`. `averageSurvivalSeconds` es el promedio de los segundos vivos por resultado de jugador. Con cero resultados las métricas son cero. `queryMs` y `serverProcessingMs` sirven para diagnóstico interno; la meta de 200 ms debe verificarse midiendo una petición HTTP real desde el cliente.

`POST /api/test/seed` permite dos formatos:

```json
{"count":100,"seed":42}
```

El generador produce partidas reproducibles con la misma semilla. También admite `{"matches":[...100 a 1000 partidas con el esquema de POST /api/matches...]}` para probar datos preparados por el evaluador. Un nuevo seed **reemplaza** el anterior; no duplica registros y no borra partidas reales.

Ejemplo de `POST /api/matches`:

```json
{
  "matchId": "7db5215d-2422-4d38-892a-c10c0bdd0041",
  "roomCode": "sala-uno",
  "startedAt": "2026-01-01T12:00:00.000Z",
  "endedAt": "2026-01-01T12:02:00.000Z",
  "players": [
    {
      "slot": 0, "playerId": "empleado-01", "deliveredDocuments": 8,
      "paperBallsThrown": 10, "paperHitsLanded": 5, "paperHitsReceived": 2,
      "knockouts": 2, "deaths": 1, "survivalSeconds": 117
    },
    {
      "slot": 1, "playerId": "empleado-02", "deliveredDocuments": 4,
      "paperBallsThrown": 6, "paperHitsLanded": 2, "paperHitsReceived": 5,
      "knockouts": 1, "deaths": 2, "survivalSeconds": 114
    }
  ]
}
```

Los impactos de un jugador deben coincidir con los recibidos del otro; sus eliminaciones deben coincidir con las veces que el rival quedó eliminado. `survivalSeconds` no puede superar la duración. Si se repite `matchId`, responde `200` con `duplicate: true`; la primera grabación responde `201`. Si hay empate, `winnerSlot` es `null`.

## Ejecutar localmente

1. Instala Node.js 20+ y ten una base PostgreSQL accesible. El servidor crea las tablas al iniciar.
2. En PowerShell, dentro de esta carpeta, ejecuta `npm ci`.
3. Define variables **sólo en tu terminal o en Render**, no en el código ni en Git:

   ```powershell
   $env:DATABASE_URL = 'postgresql://usuario:contrasena@host:5432/perrob'
   $env:ADMIN_TOKEN = 'un-token-aleatorio-de-al-menos-24-caracteres'
   $env:MATCH_INGEST_TOKEN = 'otro-token-aleatorio-de-al-menos-24-caracteres'
   $env:PORT = '3000'
   npm start
   ```

   Para generar un token seguro en PowerShell: `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`. Genera **dos diferentes**. Si tu proveedor exige TLS para PostgreSQL, usa su URI y configuración de conexión indicadas por el proveedor; la URL interna de Render es preferible cuando backend y base están en la misma región.

4. En otra terminal prueba:

   ```powershell
   Invoke-RestMethod http://localhost:3000/health
   Invoke-RestMethod http://localhost:3000/api/test/telemetry
   Invoke-RestMethod -Uri http://localhost:3000/api/test/seed -Method Post -Headers @{Authorization="Bearer $env:ADMIN_TOKEN"} -ContentType 'application/json' -Body '{"count":100,"seed":42}'
   Invoke-RestMethod http://localhost:3000/api/test/telemetry?source=seed
   ```

   Repite con `{"count":1000,"seed":42}` y confirma `totalMatches: 1000`.

5. `npm test` ejecuta pruebas de API y base simulada. Estas pruebas no sustituyen una prueba final contra PostgreSQL real ni la medición de latencia pública.

## Desplegar

Sube esta carpeta a un repositorio propio, crea PostgreSQL en Render y un **Web Service** Node conectado a ese repositorio. Configura `npm ci` como Build Command y `npm start` como Start Command. En Environment agrega `DATABASE_URL` (preferiblemente la URL interna de la base), `ADMIN_TOKEN` y `MATCH_INGEST_TOKEN`. Render aporta `PORT`. La API permite por defecto el origen del iframe WebGL actual, `https://html-classic.itch.zone`. Si itch.io cambia el origen o publicas en otra plataforma, configura `CORS_ORIGIN` con el origen HTTPS real del iframe; se pueden indicar varios separados por comas. PC y móvil nativos no requieren CORS. Verifica `https://TU-SERVICIO.onrender.com/health`, luego seed y telemetry por HTTPS.

La instancia web gratuita de Render se suspende después de inactividad y puede tardar cerca de un minuto en despertar; ese primer request no cumple la meta de 200 ms. La base gratuita expira a los 30 días. Para una evaluación estricta de disponibilidad/latencia usa un servicio que permanezca activo y mide desde la ubicación del evaluador. No se puede garantizar <200 ms únicamente porque la consulta SQL sea rápida.

## Conexión pendiente con Unity

Este repositorio ya recibe el resumen real, pero el juego actual **todavía no lo envía**. En `OfficeFusionPlayer`, el host tendrá que contar lanzamientos, impactos, eliminaciones propias y sufridas, y tiempo vivo. En `OfficeHudController.FinishRound`, el host deberá reunir ambos resultados, crear un `matchId` una sola vez y hacer un `POST /api/matches` con reintentos usando el mismo ID. Las dos cuentas de impacto y eliminación se deben actualizar en el punto donde el host aplica daño a través de `PaperBallProjectile`; no estimarlas desde la UI.

`MATCH_INGEST_TOKEN` está pensado para un **emisor confiable del lado servidor**. El modo Host actual corre en el dispositivo de un jugador: cualquier clave embebida en una build de Unity podría extraerse y falsificar resultados. Para estadísticas competitivas reales se necesita un servidor dedicado o un mecanismo que verifique el resultado con Photon. Durante una demostración controlada se puede probar el endpoint con Postman/PowerShell, pero no considerar segura una clave metida en el cliente.

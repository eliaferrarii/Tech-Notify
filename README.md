# Tech Notify

App Windows Electron per ricevere notifiche tecnici dal PC NOC con Deskz.

## Configurazione

Nella app inserire:

- IP del PC NOC
- porta del server Deskz, di default `8080`
- username e password API configurati nella app NOC
- nome tecnico come appare in Zoho Desk

La app chiusa dalla X resta attiva in background nella tray.

## Sviluppo

```powershell
npm install
npm start
```

## Build Windows

```powershell
npm run build
```

## Release

Il workflow GitHub pubblica automaticamente l'installer Windows quando viene fatto push su `main`.

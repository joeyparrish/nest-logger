# Nest Logger — Server

Express + SQLite server that receives readings from the Chrome extension and
serves the Plotly.js chart.

- **Port:** 51920
- **Chart:** http://localhost:51920
- **Database:** `nest.db` (created automatically on first run)

## Running manually

```bash
npm install   # first time only
npm start
```

## Running as a systemd user service

This keeps the server running in the background and starts it automatically at
boot, without requiring a login.

**Install:**

```bash
cp nest-logger.service ~/.config/systemd/user/
```

Edit `~/.config/systemd/user/nest-logger.service` and update `ExecStart` to
the actual path of `start.sh` on your machine.

```bash
loginctl enable-linger $USER          # start user session at boot (once ever)
systemctl --user daemon-reload
systemctl --user enable --now nest-logger
```

**Useful commands:**

```bash
systemctl --user status nest-logger
journalctl --user -u nest-logger -f   # live logs
systemctl --user restart nest-logger
systemctl --user stop nest-logger
```

## Seed / dummy data

```bash
node seed.js
```

Generates 3 days of synthetic 5-minute readings. Safe to run any time
(`INSERT OR IGNORE`). Delete `nest.db` first for a completely fresh dataset.

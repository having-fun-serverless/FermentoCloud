# FermentoCloud Pi collector

Reads a DS18B20 temperature probe over 1-Wire and uploads readings to the
FermentoCloud cloud API, buffering locally in SQLite when the network is down.

## One-time hardware setup

1. Wire the DS18B20 data pin to a GPIO pin (with a 4.7kΩ pull-up to 3.3V) per
   the standard DS18B20-on-Pi wiring guide.
2. Enable the 1-Wire kernel driver: add `dtoverlay=w1-gpio` to
   `/boot/firmware/config.txt`, then reboot.
3. Confirm the sensor is visible: `ls /sys/bus/w1/devices/28-*` should list one
   directory.

## One-time software setup

```bash
cd /home/pi/FermentoCloud/pi
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env: fill in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for the
# fermento-pi-writer IAM user, and FERMENTO_FUNCTION_URL from the cloud deploy output.
sudo mkdir -p /var/lib/fermento && sudo chown pi:pi /var/lib/fermento

sudo cp systemd/fermento-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fermento-collector
```

## Checking it's running

```bash
systemctl status fermento-collector
journalctl -u fermento-collector -f
```

## Deploying a change

Raspberry Pi Connect gives only a browser-based shell (no SSH/rsync/scp), so
there's no automated push. Paste this into the Connect shell, using `main` for
a real deploy or any branch name to try it on hardware before merging:

```bash
cd /home/pi/FermentoCloud && git fetch && git checkout <ref> && git pull && sudo systemctl restart fermento-collector
```

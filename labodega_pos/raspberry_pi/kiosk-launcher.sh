#!/bin/bash
# Labodega Restaurant POS Kiosk Launcher

# Wait for desktop to fully load
sleep 5

# Disable screen blanking and power management
xset s off
xset -dpms
xset s noblank

# Set screen to never turn off via gsettings
gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout 0 2>/dev/null
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-timeout 0 2>/dev/null
gsettings set org.gnome.settings-daemon.plugins.power idle-dim false 2>/dev/null

# Disable screensaver and lock screen
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false 2>/dev/null
gsettings set org.gnome.desktop.screensaver ubuntu-lock-on-suspend false 2>/dev/null

# Kill any existing kiosk Chrome instances
pkill -f "chrome-kiosk" 2>/dev/null
sleep 1

# Launch Chrome in kiosk mode for Odoo POS
/usr/bin/google-chrome \
    --kiosk \
    --no-first-run \
    --disable-translate \
    --disable-infobars \
    --disable-suggestions-service \
    --disable-save-password-bubble \
    --disable-session-crashed-bubble \
    --noerrdialogs \
    --disable-component-update \
    --check-for-update-interval=31536000 \
    --disable-features=TranslateUI \
    --autoplay-policy=no-user-gesture-required \
    --start-fullscreen \
    --window-position=0,0 \
    --ignore-certificate-errors-spki-list \
    --ignore-certificate-errors \
    "https://erp.labodegacalhoun.com/pos/ui?config_id=1" &

echo "Kiosk launched at $(date)" >> /tmp/kiosk.log







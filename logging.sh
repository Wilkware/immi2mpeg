#!/bin/bash -e

echo "Starting logging ..."
sudo journalctl -u immi2mpeg.service -f

echo "Done!"

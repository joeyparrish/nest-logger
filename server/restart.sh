#!/bin/bash

set -e
set -x

systemctl --user daemon-reload
systemctl --user restart nest-logger.service 

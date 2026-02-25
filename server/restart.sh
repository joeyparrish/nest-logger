#!/bin/bash

systemctl --user daemon-reload
systemctl --user restart nest-logger.service 

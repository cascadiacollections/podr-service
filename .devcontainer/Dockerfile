# The upstream devcontainer Python image ships /etc/apt/sources.list.d/yarn.list,
# whose signing key has since rotated (NO_PUBKEY 62D54FD4003F6525). That makes every
# `apt-get update` in the image fail, which in turn fails devcontainer feature
# installation and the Codespaces prebuild. This project uses uv and the Node feature
# (nvm-based), never apt-installed Yarn, so the dead repository is simply removed.
# Features are layered on top of this image, so the cleanup lands before they run.
FROM mcr.microsoft.com/devcontainers/python:1-3.13-bookworm

RUN rm -f /etc/apt/sources.list.d/yarn.list /usr/share/keyrings/yarn-archive-keyring.gpg \
    && apt-get update \
    && rm -rf /var/lib/apt/lists/*

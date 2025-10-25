# Podr's RESTful API

[![Node.js CI](https://github.com/cascadiacollections/podr-service/actions/workflows/node.js.yml/badge.svg)](https://github.com/cascadiacollections/podr-service/actions/workflows/node.js.yml)

This project contains the RESTful API implementation for https://www.podrapp.com/.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (see package.json for supported versions)
- [Yarn](https://yarnpkg.com/)

### Setup

```bash
# Install dependencies
yarn install

# Run development server
yarn dev

# Build for production
yarn build
```

### Testing and Linting

```bash
# Run tests
yarn test

# Watch mode for tests
yarn test:watch

# Lint code
yarn lint

# Fix linting issues
yarn lint:fix

# Format code
yarn format
```

### Dev Container

This repository includes a dev container configuration for VS Code. To use it:

1. Install the [Remote - Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension
2. Open the repository in VS Code
3. Click on the green icon in the bottom-left corner of VS Code
4. Select "Reopen in Container"

The dev container comes with all necessary dependencies pre-installed.

### Deployment

The project uses automated deployments via GitHub Actions. Pushes to the `main` branch automatically trigger deployment to Cloudflare Workers after all CI checks pass.

#### Automated Deployment

Deployments are automatically triggered on:

- Pushes to the `main` branch
- Manual workflow dispatch via GitHub UI

The deployment workflow requires the following GitHub secrets to be configured:

- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token with Workers deployment permissions
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

#### Manual Deployment

You can also deploy manually from your local machine:

```bash
# Deploy to Cloudflare Workers
yarn deploy
```

Note: Manual deployment requires Wrangler authentication via `wrangler login` or environment variables.

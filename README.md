# hao-backprop-test

A simple Express.js-based Node.js server tutorial with two HTTP endpoints.

## Prerequisites

- [Node.js](https://nodejs.org/) v20.x or higher

## Setup

Install the project dependencies:

```bash
npm install
```

## Run

Start the server:

```bash
node server.js
```

The server runs on port `3000`.

## Endpoints

| Method | Path       | Response       | Status Code |
|--------|------------|----------------|-------------|
| GET    | `/`        | `Hello World`  | 200         |
| GET    | `/evening` | `Good evening` | 200         |

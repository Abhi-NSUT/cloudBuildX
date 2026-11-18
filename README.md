# CloudBuildX 🚀 | Distributed CI/CD Compute Engine

![CloudBuildX Banner](https://placehold.co/1200x300/2563eb/ffffff.png?text=CloudBuildX%20-%20Distributed%20CI/CD%20Platform&font=Montserrat)

> A highly scalable, distributed Continuous Integration and Continuous Deployment (CI/CD) engine built to securely clone, isolate, and execute GitHub repositories using Docker.

CloudBuildX is a custom-built infrastructure platform similar to GitHub Actions. It features a fully decoupled architecture with a React frontend, an Express REST API, a Redis job queue, and a dedicated Docker-based Worker node that safely executes untrusted code in isolated container environments.

## ✨ Core Engineering Features

*   **Distributed Architecture:** API and Worker servers are decoupled using a BullMQ Redis message broker, enabling atomic job locking and infinite horizontal scaling of worker nodes.
*   **Efficient Data Access:** Uses Prisma ORM with parallelized queries (`Promise.all`) for the analytics dashboard (SQL `groupBy` status aggregation + recent build durations) and paginated build history.
*   **Wake-on-Demand Workers:** Idle workers automatically sleep after 5 minutes and are woken instantly via a Redis Pub/Sub signal when a build is queued, conserving serverless Redis command quotas.
*   **Build Cancellation:** Builds can be cancelled from the UI within the first 15 seconds; the signal is broadcast over Redis Pub/Sub and the worker kills the container mid-execution.
*   **Isolated Execution:** Safely executes untrusted user code inside ephemeral Docker containers, dynamically provisioned via the Docker Engine API with strict host memory and CPU quotas.
*   **Real-Time Telemetry:** Streams raw Docker execution logs (stdout/stderr) directly from the isolated backend containers to the browser in real-time utilizing WebSockets and Redis Pub/Sub.
*   **Infrastructure as Code (IaC):** Utilizes `js-yaml` to parse repository-level `build.yml` configuration files, dynamically injecting custom environments and commands into the execution engine.
*   **Cloud-Native Storage:** Automatically compresses successful build directories into `.zip` artifacts and securely streams them to an Amazon S3 bucket via the AWS SDK.

## 🛠️ Tech Stack

*   **Frontend:** React, TypeScript, TailwindCSS, Socket.io-client, Vite
*   **Backend API:** Node.js, Express, TypeScript, Prisma ORM, Socket.io
*   **Worker Engine:** Node.js, Docker API (Dockerode), BullMQ, `js-yaml`, AWS SDK
*   **Database:** Neon (Serverless PostgreSQL)
*   **Message Broker & Cache:** Upstash (Serverless Redis)
*   **Storage:** Amazon Web Services (AWS S3)
*   **Deployment:** Vercel (UI), Amazon EC2 (Backend Compute Node)

## 🧪 Testing the Live Demo

To test the CI/CD pipeline live on the internet:
1. Visit the deployed application: **[CloudBuildX Live Demo](https://cloud-build-gxh6kcxc8-abhi-nsuts-projects.vercel.app/)**
2. Create an account and log in.
3. Paste the URL of the test repository: `https://github.com/Abhi-NSUT/cloudbuildx-demo`
4. On the dashboard, click **"Queue Build"**.
5. Watch the architecture dynamically provision a Docker container, execute the code, and stream the logs live to your browser!

## 💻 Local Development Setup

To run CloudBuildX locally, you must have [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed.

### 1. Clone the repository
```bash
git clone https://github.com/Abhi-NSUT/cloudBuildX.git
cd cloudBuildX
```

### 2. Environment Variables
Copy the example file for both the API and the Worker. The defaults already match the local Docker Compose services:
```bash
cp .env.example .env
cp .env.example worker/.env
```

### 3. Start the Infrastructure (Database, Redis, MinIO)
We use Docker Compose to spin up local instances of PostgreSQL, Redis, and S3-compatible storage (MinIO):
```bash
docker-compose up -d postgres redis minio
```
Then open the MinIO console at http://localhost:9001 (login `admin` / `strongpassword123`) and create a bucket named `cloudbuildx-artifacts`.

> Prefer running everything in containers? `docker-compose up -d --build` starts the API, Worker and UI as well (UI on http://localhost).

### 4. Start the API
```bash
npm install
npx prisma db push
npm run dev
```

### 5. Start the Worker (In a new terminal)
```bash
cd worker
npm install
npm run dev
```

### 6. Start the Frontend (In a new terminal)
```bash
cd ui
npm install
npm run dev
```

## 🏗️ Architecture

### Real-Time Build Log Streaming
Container stdout/stderr is captured by the Worker, published to Redis Pub/Sub, and relayed by the API to the browser over WebSockets.

![Build Log Streaming Pipeline](docs/log-streaming-pipeline.png)

### Isolated Execution & Artifact Storage
The Worker clones the repository, runs it inside a resource-limited Docker container (512 MB RAM, 50% CPU) via Dockerode, then zips the output and streams it to S3. Artifacts are downloaded through short-lived pre-signed URLs.

![Dockerode Artifact Storage](docs/artifact-storage.png)

## 🐛 Known Issues & Future Improvements
- **GitHub Webhooks:** Implement GitHub App webhooks to automatically trigger builds when code is pushed to the `main` branch.
- **GitHub OAuth:** Replace JWT email authentication with direct GitHub OAuth integration.

---

*Designed and engineered by Abhijeet Singh.*
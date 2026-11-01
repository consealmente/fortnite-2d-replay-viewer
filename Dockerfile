FROM mcr.microsoft.com/dotnet/sdk:10.0 AS parser
WORKDIR /app
COPY vendor/parser/ vendor/parser/
COPY bridge/ bridge/
RUN dotnet build bridge/bridge.csproj -c Release

FROM mcr.microsoft.com/dotnet/sdk:10.0
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=parser /app/vendor/parser/ vendor/parser/
COPY --from=parser /app/bridge/ bridge/
COPY public/ public/
COPY src/ src/
COPY server.js ./
ENV NODE_ENV=production PUBLIC_WEBSITE=1 PORT=3000 DOTNET_CLI_TELEMETRY_OPTOUT=1
EXPOSE 3000
CMD ["node", "server.js"]

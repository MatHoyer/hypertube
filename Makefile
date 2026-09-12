.PHONY: network vpn stop-vpn logs-vpn refresh-vpn-sidecars infra stop-infra logs-infra helpers stop-helpers logs-helpers prod stop-prod logs-prod compact stop-compact logs-compact stop-all rebuild-prod rebuild-compact reset

# External network shared by all compose files. Idempotent: no-op if it already exists.
network:
	docker network inspect hypertube-network >/dev/null 2>&1 || docker network create hypertube-network

# Sidecars use network_mode: container:vpn — they must be recreated when the VPN
# container is replaced, or DNS/networking breaks inside Prowlarr/Transmission.
refresh-vpn-sidecars:
	docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --force-recreate transmission
	docker compose -f docker-compose-prod.yml up -d --force-recreate prowlarr subtitle-proxy

# VPN
vpn: network
	docker compose -f docker-compose-vpn.yml -f docker-compose-vpn.override.yml up -d
	@VPN_ID=$$(docker inspect -f '{{.Id}}' vpn 2>/dev/null); \
	PROWLARR_NS=$$(docker inspect -f '{{.HostConfig.NetworkMode}}' hypertube-prowlarr-prod 2>/dev/null || true); \
	if [ -n "$$VPN_ID" ] && [ "container:$$VPN_ID" != "$$PROWLARR_NS" ]; then \
		echo "VPN container changed — recreating sidecars..."; \
		$(MAKE) refresh-vpn-sidecars; \
	fi

stop-vpn:
	docker compose -f docker-compose-vpn.yml -f docker-compose-vpn.override.yml down

logs-vpn:
	docker compose -f docker-compose-vpn.yml -f docker-compose-vpn.override.yml logs -f

# Infra
infra: vpn
	docker compose -f docker-compose.yml -f docker-compose.override.yml up -d

stop-infra:
	docker compose -f docker-compose.yml -f docker-compose.override.yml down

logs-infra:
	docker compose -f docker-compose.yml -f docker-compose.override.yml logs -f

# Helpers
helpers: network
	docker compose -f docker-compose-helpers.yml up -d

stop-helpers:
	docker compose -f docker-compose-helpers.yml down

logs-helpers:
	docker compose -f docker-compose-helpers.yml logs -f

# Prod
prod: infra
	docker compose -f docker-compose-prod.yml up -d

stop-prod:
	docker compose -f docker-compose-prod.yml down

logs-prod:
	docker compose -f docker-compose-prod.yml logs -f

# Compact (single app container: front + API + scheduler). Mutually exclusive
# with `prod` — both define the same container names for shared services
# (prowlarr, subtitle-proxy, migrate), so do not run both at once.
compact: infra
	docker compose -f docker-compose-compact.yml up -d

stop-compact:
	docker compose -f docker-compose-compact.yml down

logs-compact:
	docker compose -f docker-compose-compact.yml logs -f

# Stop everything
stop-all: stop-prod stop-vpn stop-helpers stop-infra

rebuild-vpn: stop-vpn
	docker compose -f docker-compose-vpn.yml -f docker-compose-vpn.override.yml build --no-cache
	$(MAKE) vpn

rebuild-infra: stop-infra
	docker compose -f docker-compose.yml -f docker-compose.override.yml build --no-cache
	$(MAKE) infra

rebuild-helpers: stop-helpers
	docker compose -f docker-compose-helpers.yml build --no-cache
	$(MAKE) helpers

rebuild-prod: stop-prod
	docker compose -f docker-compose-prod.yml build --no-cache
	$(MAKE) prod

rebuild-compact: stop-compact
	docker compose -f docker-compose-compact.yml build --no-cache
	$(MAKE) compact

reset: stop-all
	docker system prune -af && docker volume prune -af


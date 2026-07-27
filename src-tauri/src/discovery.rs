use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::task::JoinHandle;
use uuid::Uuid;

const SERVICE_TYPE: &str = "_rollmap._tcp.local.";
const DISCOVERY_TTL: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredLanPeer {
    device_id: String,
    base_urls: Vec<String>,
    protocol_major: u32,
    app_version: String,
    pairing_available: bool,
    last_seen_ms: i64,
}

struct CachedPeer {
    peer: DiscoveredLanPeer,
    seen_at: SystemTime,
}

pub struct LanDiscovery {
    daemon: ServiceDaemon,
    service_fullname: String,
    peers: Arc<Mutex<HashMap<String, CachedPeer>>>,
    browser_task: JoinHandle<()>,
}

impl LanDiscovery {
    pub fn start(port: u16, local_device_id: String) -> Result<Self, String> {
        Uuid::parse_str(&local_device_id)
            .map_err(|_| "Local device identity must be a UUID".to_string())?;
        let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|error| error.to_string())?;
        let hostname = format!("rollmap-{local_device_id}.local.");
        let properties = HashMap::from([
            (
                "protocolMajor".to_string(),
                crate::sync_protocol::PROTOCOL_MAJOR.to_string(),
            ),
            ("deviceId".to_string(), local_device_id.clone()),
            (
                "appVersion".to_string(),
                env!("CARGO_PKG_VERSION").to_string(),
            ),
            ("pairingAvailable".to_string(), "true".to_string()),
        ]);
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &local_device_id,
            &hostname,
            "",
            port,
            properties,
        )
        .map_err(|error| error.to_string())?
        .enable_addr_auto();
        let service_fullname = service.get_fullname().to_string();
        daemon
            .register(service)
            .map_err(|error| error.to_string())?;

        let peers = Arc::new(Mutex::new(HashMap::new()));
        let task_peers = Arc::clone(&peers);
        let browser_task = tokio::spawn(async move {
            while let Ok(event) = receiver.recv_async().await {
                match event {
                    ServiceEvent::ServiceResolved(service) => {
                        let fullname = service.fullname.clone();
                        if let Some(peer) = resolved_peer(&service, &local_device_id) {
                            if let Ok(mut peers) = task_peers.lock() {
                                peers.insert(
                                    fullname,
                                    CachedPeer {
                                        peer,
                                        seen_at: SystemTime::now(),
                                    },
                                );
                            }
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        if let Ok(mut peers) = task_peers.lock() {
                            peers.remove(&fullname);
                        }
                    }
                    _ => {}
                }
            }
        });

        Ok(Self {
            daemon,
            service_fullname,
            peers,
            browser_task,
        })
    }

    pub fn peers(&self) -> Vec<DiscoveredLanPeer> {
        let Ok(mut cached) = self.peers.lock() else {
            return Vec::new();
        };
        cached.retain(|_, peer| {
            peer.seen_at
                .elapsed()
                .is_ok_and(|elapsed| elapsed <= DISCOVERY_TTL)
        });
        let mut peers = cached
            .values()
            .map(|cached| cached.peer.clone())
            .collect::<Vec<_>>();
        peers.sort_by(|left, right| left.device_id.cmp(&right.device_id));
        peers
    }

    pub async fn stop(self) {
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        let _ = self.daemon.unregister(&self.service_fullname);
        let _ = self.daemon.shutdown();
        self.browser_task.abort();
        let _ = self.browser_task.await;
    }
}

fn resolved_peer(service: &ResolvedService, local_device_id: &str) -> Option<DiscoveredLanPeer> {
    let properties = &service.txt_properties;
    let device_id = properties.get_property_val_str("deviceId")?;
    Uuid::parse_str(device_id).ok()?;
    if device_id == local_device_id {
        return None;
    }
    let protocol_major = properties
        .get_property_val_str("protocolMajor")?
        .parse::<u32>()
        .ok()?;
    let app_version = properties.get_property_val_str("appVersion")?;
    if app_version.is_empty() || app_version.len() > 64 {
        return None;
    }
    let pairing_available = properties
        .get_property_val_str("pairingAvailable")?
        .parse::<bool>()
        .ok()?;
    let mut base_urls = service
        .addresses
        .iter()
        .map(|address| address.to_ip_addr())
        .filter(is_usable_address)
        .map(|address| http_base_url(address, service.port))
        .collect::<Vec<_>>();
    base_urls.sort_by_key(|url| url.contains('['));
    base_urls.dedup();
    if base_urls.is_empty() {
        return None;
    }
    Some(DiscoveredLanPeer {
        device_id: device_id.to_string(),
        base_urls,
        protocol_major,
        app_version: app_version.to_string(),
        pairing_available,
        last_seen_ms: now_ms(),
    })
}

fn is_usable_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_loopback() && !address.is_unspecified() && !address.is_multicast()
        }
        IpAddr::V6(address) => {
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_unicast_link_local()
        }
    }
}

fn http_base_url(address: IpAddr, port: u16) -> String {
    match address {
        IpAddr::V4(address) => format!("http://{address}:{port}"),
        IpAddr::V6(address) => format!("http://[{address}]:{port}"),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn formats_only_routable_http_addresses() {
        assert!(is_usable_address(&IpAddr::V4(Ipv4Addr::new(
            192, 168, 1, 4
        ))));
        assert!(!is_usable_address(&IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_usable_address(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_usable_address(&IpAddr::V6(
            "fe80::1".parse().expect("link-local IPv6")
        )));
        assert_eq!(
            http_base_url(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 4)), 45123),
            "http://192.168.1.4:45123"
        );
        assert_eq!(
            http_base_url(
                IpAddr::V6("2001:db8::4".parse().expect("global IPv6")),
                45123
            ),
            "http://[2001:db8::4]:45123"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires a multicast-capable network interface"]
    async fn discovers_another_rollmap_service() {
        let first_device_id = "11111111-1111-4111-8111-111111111111";
        let second_device_id = "22222222-2222-4222-8222-222222222222";
        let first = LanDiscovery::start(45123, first_device_id.into()).expect("start first");
        let second = LanDiscovery::start(45124, second_device_id.into()).expect("start second");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);

        loop {
            let first_found_second = first.peers().iter().any(|peer| {
                peer.device_id == second_device_id
                    && peer
                        .base_urls
                        .iter()
                        .any(|base_url| base_url.ends_with(":45124"))
            });
            let second_found_first = second.peers().iter().any(|peer| {
                peer.device_id == first_device_id
                    && peer
                        .base_urls
                        .iter()
                        .any(|base_url| base_url.ends_with(":45123"))
            });
            if first_found_second && second_found_first {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "mDNS services did not resolve each other"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        first.stop().await;
        second.stop().await;
    }
}

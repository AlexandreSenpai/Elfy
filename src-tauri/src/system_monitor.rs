use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System, MINIMUM_CPU_UPDATE_INTERVAL};

const BYTES_PER_MIB: u64 = 1024 * 1024;
const HIGH_CPU_THRESHOLD_PERCENT: f32 = 80.0;
const HIGH_MEMORY_THRESHOLD_PERCENT: u64 = 85;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsDto {
    pub cpu_usage_percent: f32,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    pub high_load_warning: bool,
}

struct MonitorState {
    system: System,
    last_cpu_refresh: Instant,
}

impl MonitorState {
    fn new() -> Self {
        let specifics = RefreshKind::new()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything());
        let system = System::new_with_specifics(specifics);
        Self {
            system,
            last_cpu_refresh: Instant::now(),
        }
    }
}

static MONITOR_STATE: OnceLock<Mutex<MonitorState>> = OnceLock::new();

fn monitor_mutex() -> &'static Mutex<MonitorState> {
    MONITOR_STATE.get_or_init(|| Mutex::new(MonitorState::new()))
}

/// Primes the system monitor baseline on startup so subsequent CPU readings are accurate.
pub fn init_monitor() {
    let _ = monitor_mutex();
}

fn is_high_load(cpu_usage_percent: f32, memory_used_mb: u64, memory_total_mb: u64) -> bool {
    if cpu_usage_percent >= HIGH_CPU_THRESHOLD_PERCENT {
        return true;
    }
    if memory_total_mb == 0 {
        return false;
    }
    let memory_percent = memory_used_mb.saturating_mul(100) / memory_total_mb;
    memory_percent >= HIGH_MEMORY_THRESHOLD_PERCENT
}

fn round_one_decimal(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    (value.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

#[tauri::command]
pub fn get_system_metrics() -> Result<SystemMetricsDto, String> {
    let mut state = monitor_mutex()
        .lock()
        .map_err(|e| format!("System monitor lock poisoned: {e}"))?;

    if state.last_cpu_refresh.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL {
        state.system.refresh_cpu_usage();
        state.last_cpu_refresh = Instant::now();
    }

    state.system.refresh_memory();

    let cpu_usage_percent = round_one_decimal(state.system.global_cpu_usage());
    let memory_used_mb = state.system.used_memory() / BYTES_PER_MIB;
    let memory_total_mb = state.system.total_memory() / BYTES_PER_MIB;
    let high_load_warning = is_high_load(cpu_usage_percent, memory_used_mb, memory_total_mb);

    Ok(SystemMetricsDto {
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        high_load_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_metrics_returns_valid_memory_and_bounded_cpu() {
        init_monitor();
        let metrics = get_system_metrics().expect("read system metrics");
        assert!(metrics.memory_total_mb > 0);
        assert!(metrics.memory_used_mb <= metrics.memory_total_mb);
        assert!(metrics.cpu_usage_percent >= 0.0 && metrics.cpu_usage_percent <= 100.0);
    }

    #[test]
    fn high_load_threshold_detects_cpu_and_memory_pressure() {
        assert!(!is_high_load(25.0, 4096, 16384));
        assert!(is_high_load(80.0, 4096, 16384));
        assert!(is_high_load(15.0, 14000, 16384));
    }
}

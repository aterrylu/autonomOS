# DimOS Architecture & Module System

> Source: `~/workspace/dimos/` (local checkout)
> Key files: `dimos/core/module.py`, `dimos/core/stream.py`, `dimos/core/blueprints.py`, `dimos/core/transport.py`

## Package Structure

```
dimos/
├── agents/          # LangGraph agent module, @skill decorator, system prompts
├── control/         # Manipulation control (IK, trajectory planning)
├── core/            # Module, Stream, Blueprint, Transport, RPC — THE FRAMEWORK
├── hardware/        # Sensor drivers (cameras, LiDAR, force-torque)
├── manipulation/    # Grasping, pick-place, scan-objects
├── mapping/         # SLAM, voxel maps, occupancy grids, OSM
├── memory/          # Spatio-temporal memory systems
├── models/          # ML models (VLM, object detection, embeddings)
├── msgs/            # Message types (geometry_msgs, sensor_msgs — ROS-like)
├── navigation/      # Nav stack (A* replanning, ROS Nav, frontier exploration)
├── perception/      # Spatial memory, object tracking, 3D detection
├── protocol/        # Transport impls (LCM, ROS, DDS, SHM) + MCP server
├── robot/           # Robot-specific configs, blueprints, CLI
├── skills/          # Reusable skill modules (navigation, person-follow, speak)
├── spec/            # Protocol/interface specifications (duck-typed contracts)
├── teleop/          # Teleoperation (Quest VR, phone, keyboard)
├── types/           # Custom type definitions
├── utils/           # CLI, logging, monitoring, replay
├── visualization/   # Rerun bridge, Foxglove bridge
└── web/             # WebSocket visualization UI
```

## The Module System

### Base Classes

**`ModuleBase`** (`dimos/core/module.py`) — the root abstraction:
- Has an async event loop per instance
- `inputs` / `outputs` properties enumerate all `In[T]` / `Out[T]` streams
- `rpcs` classproperty collects all `@rpc` methods
- `get_skills()` collects all `@skill` methods as `SkillInfo` objects
- `module_info()` returns structured metadata
- Handles serialization for distributed (Dask) deployment

**`Module`** (extends `ModuleBase`) — deployed as a Dask Actor:
- `set_transport(stream_name, transport)` — wires a stream to a pub/sub backend
- `connect_stream(input_name, remote_stream)` — connects an input to a remote output
- `set_module_ref(name, module_ref)` — injects an RPC client for module-to-module calls
- `on_system_modules(modules)` — lifecycle hook called after all modules are deployed

### Defining a Module

```python
from dimos.core import Module, In, Out, rpc
from dimos.msgs.geometry_msgs import Twist, PoseStamped

class SimpleRobot(Module):
    cmd_vel: In[Twist]           # subscribes to velocity commands
    pose: Out[PoseStamped]       # publishes current pose

    @rpc
    def start(self) -> None:
        self.cmd_vel.subscribe(self._on_twist)

    def _on_twist(self, twist: Twist) -> None:
        self.pose.publish(PoseStamped(...))
```

## Typed Stream System

**File:** `dimos/core/stream.py`

### Stream State Machine

```
UNBOUND → READY → CONNECTED → FLOWING
  (descriptor)  (bound to module)  (transport assigned)  (data observed)
```

### Core Classes

| Class | Role |
|-------|------|
| `Out[T]` | Publishes messages. `publish(msg)` broadcasts to transport + local subscribers |
| `In[T]` | Subscribes to messages. `subscribe(cb)` registers callbacks |
| `RemoteOut[T]` | Serialized `Out` for cross-Dask-worker communication |
| `RemoteIn[T]` | Serialized `In` for cross-worker communication |
| `ObservableMixin[T]` | Adds RxPY `.observable()`, `.get_next(timeout)`, `.hot_latest()` |

### Pub/Sub Mechanism

- `Out.publish(msg)` → calls `transport.broadcast(self, msg)` + local subscriber callbacks
- `In.subscribe(cb)` → calls `transport.subscribe(cb, self)` when transport is set
- Transport abstraction: `broadcast()`, `subscribe()`, `publish()` methods

## Blueprint System

**File:** `dimos/core/blueprints.py`

### Data Model

```python
@dataclass(frozen=True)
class _BlueprintAtom:
    module: type[Module]
    streams: tuple[StreamRef, ...]      # all In/Out with names and types
    module_refs: tuple[ModuleRef, ...]   # dependencies on other modules (via Spec)
    args: tuple[Any, ...]
    kwargs: dict[str, Any]

@dataclass(frozen=True)
class Blueprint:
    blueprints: tuple[_BlueprintAtom, ...]
    transport_map: Mapping[tuple[str, type], PubSubTransport]
    global_config_overrides: Mapping[str, Any]
    remapping_map: Mapping[tuple[type[Module], str], str | type]
    requirement_checks: tuple[Callable[[], str | None], ...]
```

### Creating & Composing Blueprints

```python
# Single module
bp = ModuleA.blueprint()

# Compose multiple
combined = autoconnect(bp1, bp2, bp3)

# Override transports
combined.transports({("camera", Image): SHMTransport("/camera_shm")})

# Override global config
combined.global_config(simulation=True, n_dask_workers=4)

# Remap stream names or module references
combined.remappings([(ModuleA, "output", "renamed_output")])

# Build and deploy
coordinator = combined.build(cli_config_overrides={...})
```

### The autoconnect Algorithm

`autoconnect(*blueprints)` merges blueprints then `build()` wires everything:

1. **Deduplicate** — if same module class appears multiple times, last wins
2. **Merge** transport maps, remappings, config overrides, requirement checks
3. **On `build()`**:
   - Check requirements (GPU available? ROS installed?)
   - Deploy all modules in parallel via Dask
   - **Stream wiring**: group streams by `(remapped_name, type)`. All streams sharing the same key get the same transport — they automatically connect
   - **RPC wiring**: register all `@rpc` methods under `ClassName.method_name`
   - **Module ref wiring**: for each `some_ref: SomeSpec` attribute, find a module implementing `SomeSpec` via structural + annotation compliance check
   - Start all modules (calls `start()` RPC, then `on_system_modules()`)

### Transport Selection Logic

```python
def _get_transport_for(name, stream_type):
    # 1. Check user overrides in transport_map
    # 2. Auto-select: if type has lcm_encode → LCMTransport, else → pLCMTransport
    # 3. Generate topic name from stream name
```

## Transport Layer

**File:** `dimos/core/transport.py`, `dimos/protocol/pubsub/impl/`

| Transport | Serialization | Use Case |
|-----------|---------------|----------|
| `pLCMTransport` | Python serialization over LCM | Any Python object (default) |
| `LCMTransport` | LCM native schema | ROS-like message types (Image, PointCloud) |
| `pSHMTransport` | Serialized + shared memory | High-throughput, same-machine |
| `SHMTransport` | Raw bytes + SHM | Low-latency, large messages |
| `JpegLcmTransport` | JPEG compressed | Video over network |
| `JpegShmTransport` | JPEG + SHM | Video, same-machine |
| `ROSTransport` | ROS wire format | ROS 1/2 interop |
| `DDSTransport` | CycloneDDS | Real-time systems |

Transports are **swappable at the blueprint level** without changing module code. On macOS, `pSHMTransport` is used for high-bandwidth streams; on Linux, LCM is default for everything.

## Spec System — Interface Contracts

**File:** `dimos/spec/utils.py`, `dimos/spec/nav.py`, `dimos/spec/control.py`

Specs are Python `Protocol` classes that define contracts:

```python
class NavigationSpec(Spec, Protocol):
    def goto(self, x: float, y: float) -> bool: ...
    def get_pose(self) -> Pose: ...
```

Blueprint auto-matching checks:
1. **Structural compliance** — does the module have the methods? (duck typing)
2. **Annotation compliance** — do return types match exactly? (strict)
3. If exactly 1 match → auto-wire. If 0 or 2+ → error (use `.remappings()`)

Available specs: `GlobalPlannerSpec`, `LocalPlannerSpec`, `ManipulationSpec`, `TrajectoryControllerSpec`, `ObjectDetectionSpec`, `SpatialMemorySpec`

## Distributed Execution (Dask)

Modules are deployed as **Dask Actors** across worker processes:
- Each module runs in its own worker with its own event loop
- Inter-module communication goes through transports (LCM/SHM/ROS)
- RPC calls are serialized over LCM
- Configurable: `n_dask_workers` (default 2), `memory_limit`
- Can disable Dask for single-process mode

## Configuration System

**File:** `dimos/core/global_config.py`

```python
class GlobalConfig(BaseSettings):
    robot_ip: str | None = None
    simulation: bool = False
    replay: bool = False
    dask: bool = True
    n_dask_workers: int = 2
    viewer_backend: ViewerBackend = "rerun-web"
    mujoco_room: str | None = None
    planner_strategy: NavigationStrategy = "simple"
    # ... more
```

**Precedence** (highest first): CLI flags → env vars → `.env` file → blueprint `.global_config()` → defaults

## Takeaway for autonomOS

The DimOS architecture is a **production-grade reference** for our core abstractions:

1. **Module = node with typed I/O** is the right primitive. We should adopt this for agents, dashboards, cron schedulers.
2. **Blueprint = declarative composition** solves the "how do I configure a system" problem. We need something similar for agent workflow configs.
3. **autoconnect by (name, type)** is elegant — reduces manual wiring to zero for well-named streams.
4. **Spec contracts** decouple modules from implementations. Critical for a plugin ecosystem.
5. **Transport abstraction** means the same module works locally (SHM), on the network (LCM), or with ROS. We should abstract our communication layer similarly.
6. **Dask for distribution** is a smart choice — modules are actors, communication is via pub/sub. We might not need Dask, but the actor model is right.

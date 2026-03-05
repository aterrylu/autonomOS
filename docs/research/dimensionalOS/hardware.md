# DimOS Hardware Support & Capabilities

> Source: `~/workspace/dimos/dimos/robot/`, `~/workspace/dimos/dimos/hardware/`

## Supported Robots

### Quadrupeds

| Robot | Status | Connection | Path |
|-------|--------|------------|------|
| **Unitree Go2 Pro/Air** | Stable | WebRTC (stock firmware 1.1.7+) | `robot/unitree/go2/` |
| **Unitree B1** | Experimental | UDP (`192.168.123.14:9090`) | `robot/unitree/b1/` |

### Humanoids

| Robot | Status | Connection | Path |
|-------|--------|------------|------|
| **Unitree G1** | Beta | WebRTC | `robot/unitree/g1/` |

### Manipulators

| Robot | Status | SDK | Path |
|-------|--------|-----|------|
| **XArm6/XArm7** | Experimental | `xarm-python-sdk >= 1.17.0` | `robot/manipulators/xarm/` |
| **AgileX Piper** | Experimental | `piper-sdk` | `robot/manipulators/piper/` |

### Drones

| Robot | Status | Protocol | Path |
|-------|--------|----------|------|
| **MAVLink drones** | Experimental | MAVLink UDP (`udp:0.0.0.0:14550`) | `robot/drone/` |

## Unitree Go2 Deep Dive (Primary Platform)

### Connection Module (`robot/unitree/go2/connection.py`)

`GO2Connection` auto-selects backend based on config:
- `webrtc` → real hardware via `UnitreeWebRTCConnection`
- `mujoco` → physics simulation via `MujocoConnection`
- `replay` → recorded data via `ReplayConnection`

### Published Streams (Outputs)

| Stream | Type | Description |
|--------|------|-------------|
| `lidar` | `Out[PointCloud2]` | Raw 3D point cloud |
| `odom` | `Out[PoseStamped]` | Robot odometry/pose |
| `color_image` | `Out[Image]` | Camera feed (1280x720 @10fps) |
| `camera_info` | `Out[CameraInfo]` | Camera intrinsics |
| `pointcloud` | `Out[PointCloud2]` | Processed point cloud |
| `tf` | `Out[Transform]` | Frame transforms (base_link, camera_link, camera_optical) |

### Subscribed Streams (Inputs)

| Stream | Type | Description |
|--------|------|-------------|
| `cmd_vel` | `In[Twist]` | Velocity commands (linear x/y, angular z) |

### WebRTC Motor Control

The lowest level — `UnitreeWebRTCConnection.move()`:
```python
self.conn.datachannel.pub_sub.publish_without_callback(
    RTC_TOPIC["WIRELESS_CONTROLLER"],
    data={"lx": -y, "ly": x, "rx": -yaw, "ry": 0},
)
```

WebRTC topics: `WIRELESS_CONTROLLER` (movement), `SPORT_MOD` (standup/liedown), `MOTION_SWITCHER` (mode changes)

### Available Blueprints (10+)

| Blueprint | What it includes |
|-----------|-----------------|
| `unitree-go2-basic` | Connection + visualization only |
| `unitree-go2` | Full nav stack (voxel mapping + A* planning) |
| `unitree-go2-agentic` | Nav + LLM agent (GPT-4O) |
| `unitree-go2-agentic-ollama` | Nav + agent (local Ollama) |
| `unitree-go2-agentic-mcp` | Nav + agent + MCP server |
| `unitree-go2-detection` | Nav + object detection |
| `unitree-go2-spatial` | Nav + spatial memory (ChromaDB) |
| `unitree-go2-ros` | ROS 2 bridge mode |
| `unitree-go2-temporal-memory` | Agent + temporal memory |
| `unitree-go2-vlm-stream-test` | VLM vision integration |

## Sensors

### Cameras (`hardware/sensors/camera/`)

| Type | File | Notes |
|------|------|-------|
| USB Webcam | `webcam.py` | Default fallback |
| ZED Stereo | `zed/camera.py` | Depth camera |
| Intel RealSense | `realsense/camera.py` | Depth camera |
| GStreamer | `gstreamer/gstreamer_camera.py` | Network streaming |

All publish: `color_image: Out[Image]`, `camera_info: Out[CameraInfo]`, `tf: Out[Transform]`

### LiDAR (`hardware/sensors/lidar/`)

| Type | File | Notes |
|------|------|-------|
| Livox Mid-360 | `lidar/livox/module.py` | Native C++ driver, 10Hz |
| FastLIO2 SLAM | `lidar/fastlio2/module.py` | LiDAR-inertial odometry |

Livox config: Host IP `192.168.1.5`, LiDAR IP `192.168.1.155`, optional IMU

## Simulation — MuJoCo

**File:** `robot/unitree/mujoco_connection.py`

### How It Works

1. DimOS launches MuJoCo as a subprocess
2. Communication via **shared memory** (SHM) for fast IPC
3. Same module code runs in sim — no changes needed
4. Camera: 1280x720 @10fps with computed intrinsics
5. LiDAR: full ray-casting simulation
6. Odometry: ground-truth pose from MuJoCo

### Configuration

```bash
dimos --simulation run unitree-go2
```

| Config | Default | Description |
|--------|---------|-------------|
| `mujoco_steps_per_frame` | 7 | Physics timesteps per rendered frame |
| `mujoco_room` | None | Environment (apartment, office) |
| `mujoco_start_pos` | "-1.0, 1.0" | Robot spawn location |
| `mujoco_camera_position` | None | Override camera placement |

No GPU required — CPU simulation works fine.

## Replay System

**File:** `dimos/utils/testing/replay.py`

### Classes

- `TimedSensorStorage` — records sensor streams to disk with timestamps
- `TimedSensorReplay` — replays recorded data with original timing

### Available Recordings (Git LFS)

| File | Size | Content |
|------|------|---------|
| `unitree_go2_bigoffice.tar.gz` | 2.3 GB | LiDAR + video + odometry |
| `unitree_go2_lidar_corrected.tar.gz` | 1.2 GB | Corrected LiDAR frames |
| `unitree_go2_office_walk2.tar.gz` | 1.7 GB | Office navigation |
| `unitree_raw_webrtc_replay.tar.gz` | 750 MB | Raw WebRTC frames |
| `replay_g1.tar.gz` | 560 MB | G1 humanoid walk |
| `replay_g1_run.tar.gz` | 560 MB | G1 humanoid running |
| `rgbd_frames.tar.gz` | 948 MB | RGBD sequences |

```bash
dimos --replay run unitree-go2
# Downloads ~2.4 GB on first run, opens localhost:7779
```

## Navigation Stack

| Module | File | Algorithm |
|--------|------|-----------|
| A* Replanning | `navigation/replanning_a_star/module.py` | Dynamic re-planning on occupancy grid |
| ROS Navigation | `navigation/rosnav.py` | Nav2 stack integration (ROS 1/2) |
| Frontier Exploration | `navigation/frontier_exploration/` | Wavefront frontier goal selection |
| Visual Servoing | — | Path following via camera |
| BBox Navigation | — | Navigate to bounding box targets |

## Perception Pipeline

| Module | File | What it does |
|--------|------|--------------|
| **Spatial Memory** | `perception/spatial_perception.py` | CLIP/ResNet embeddings in ChromaDB. Semantic search by text or image. Named locations. |
| **Object Tracker 3D** | `perception/object_tracker.py` | Tracks objects across frames in 3D space |
| **Object Scene Registration** | `perception/object_scene_registration.py` | Projects 2D detections to 3D geometry |
| **Detection 3D** | `perception/detection/module3D.py` | 3D object detection from point clouds |
| **Person Tracker** | — | Specialized 2D+3D person tracking |
| **Temporal Memory** | `perception/experimental/temporal_memory/` | Spatio-temporal event logging for agent context |

### Spatial Memory Architecture

```
Camera frames + Odometry
    → CLIP/ResNet embedding (512-dim)
    → ChromaDB vector store
        Schema: (image_id, embedding[512], xy_position, timestamp, metadata)
    → Queryable by:
        - Semantic text: "where is the kitchen?"
        - Image similarity: "find something that looks like this"
        - Named location: "go to desk"
```

## Visualization

| Tool | Transport | Access |
|------|-----------|--------|
| **Rerun** (3D viewer) | WebSocket | `localhost:7779` (web) or native app |
| **Foxglove** | WebSocket | Alternative web viewer |
| **WebSocket Command Center** | WebSocket | `localhost:7779` — click to navigate, toggle modes |

## CLI Commands

```bash
dimos run BLUEPRINT           # Launch a blueprint
dimos --simulation run ...    # MuJoCo sim mode
dimos --replay run ...        # Replay recorded data
dimos list                    # List all blueprints
dimos show-config             # Show GlobalConfig values
dimos topic echo /topic Type  # Monitor LCM topic
dimos topic send /topic data  # Send to LCM topic
dimos lcmspy                  # LCM monitor
dimos agentspy                # Monitor agent thinking
dimos humancli                # Interactive agent CLI
dimos rerun-bridge            # Launch Rerun visualization
```

## Installation

```bash
# Minimal (replay only)
uv venv --python 3.12 && source .venv/bin/activate
uv pip install dimos[base,unitree]
dimos --replay run unitree-go2

# With simulation
uv pip install dimos[base,unitree,sim]
dimos --simulation run unitree-go2

# With LLM agent
uv pip install dimos[base,unitree,agents]
export OPENAI_API_KEY=sk-...
dimos run unitree-go2-agentic

# With real hardware
export ROBOT_IP=192.168.1.100
dimos run unitree-go2

# With MCP (for OpenClaw/Claude Code)
dimos run unitree-go2-agentic-mcp
```

**Platforms:** Ubuntu 22.04/24.04 (stable), NixOS (stable), macOS (alpha)
**Python:** 3.10+ (tested on 3.12)

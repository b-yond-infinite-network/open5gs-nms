# Kubernetes Lab Script Command Map

The **K8s Lab** page exposes the operational scripts from the sibling
`laas-5gsa-k8s-1` repository. The backend runs each script from its own folder
as `K8S_EXEC_USER`, with `K8S_KUBECONFIG` exported for `kubectl`.

| GUI action | Script command | Result shown in GUI |
| --- | --- | --- |
| Start 5GSA Lab | `INSTALL/START_5gsa.sh` | Exit status, stdout/stderr, deployment log |
| Stop 5GSA Lab | `INSTALL/STOP_5gsa.sh` | Exit status, stdout/stderr, cleanup log |
| Install K8s Node | `INSTALL/INSTALL_NODE_k8s.sh` | Exit status and stdout/stderr |
| Delete K8s Node | `INSTALL/DELETE_NODE_k8s.sh` | Exit status and stdout/stderr |
| Create UE / Normal | `SCRIPTS/ue_create.sh <count>` | Exit status, stdout/stderr, generated UE folders |
| Create UE / Auth Error | `SCRIPTS/ue_create_auth_error.sh <count>` | Exit status, stdout/stderr, generated UE folders |
| Create UE / DNN Error | `SCRIPTS/ue_create_dnn_error.sh <count>` | Exit status, stdout/stderr, generated UE folders |
| Create UE / IMSI Error | `SCRIPTS/ue_create_imsi_error.sh <count>` | Exit status, stdout/stderr, generated UE folders |
| Create UE / Slice Error | `SCRIPTS/ue_create_slice_error.sh <count>` | Exit status, stdout/stderr, generated UE folders |
| Attach UE(s) | `SCRIPTS/attach_ue.sh` | Exit status and stdout/stderr |
| Detach UE(s) | `SCRIPTS/dettach_ue.sh` | Exit status and stdout/stderr |
| Remove UE(s) | `SCRIPTS/remove_ue.sh` | Exit status, stdout/stderr, refreshed UE folders |
| Run Traffic Test | `SCRIPTS/traffic_ue.sh` | Per-tunnel ping output and exit status |

The `SCRIPTS/ue*/wrapper.sh` files are container entrypoints referenced by the
generated UE deployments. They are not standalone operator commands and are
therefore not exposed as GUI buttons.

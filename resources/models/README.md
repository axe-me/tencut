# Bundled models

Both are Apache-2.0, released by OpenMMLab (MMPose / MMDetection), exported to ONNX by the MMPose team
("onnx_sdk" packages used by rtmlib).

| File | Model | Source |
|---|---|---|
| `yolox-tiny-humanart.onnx` | YOLOX-tiny person detector trained on HumanArt, 416×416, NMS in graph | https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_tiny_8xb8-300e_humanart-6f3252f9.zip |
| `rtmpose-t-body7.onnx` | RTMPose-t (Body7), 256×192, SimCC heads, 17 COCO keypoints | https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-t_simcc-body7_pt-body7_420e-256x192-026a1439_20230504.zip |

Licences: MMPose (https://github.com/open-mmlab/mmpose) and YOLOX (https://github.com/Megvii-BaseDetection/YOLOX) are Apache-2.0.

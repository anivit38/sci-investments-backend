import torch
import torch.nn as nn

class LSTMClassifier(nn.Module):
    def __init__(self, in_features: int, hidden_size: int = 64, num_layers: int = 1, dropout: float = 0.1):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=in_features,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )
        self.head = nn.Sequential(
            nn.Linear(hidden_size, hidden_size),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size, 1)  # binary logit
        )

    def forward(self, x):
        # x: [B, T, F]
        out, _ = self.lstm(x)        # [B, T, H]
        last = out[:, -1, :]         # last timestep
        logit = self.head(last)      # [B, 1]
        return logit.squeeze(1)      # [B]

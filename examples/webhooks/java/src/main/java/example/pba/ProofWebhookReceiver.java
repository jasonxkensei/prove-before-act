package example.pba;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class ProofWebhookReceiver {
    // Register the webhook_secret from each certification response by its proof ID.
    // For a real deployment replace this in-memory example with durable secret storage.
    private final Map<String, String> secrets = new ConcurrentHashMap<>();
    private final Map<String, ProofCertifiedPayload> deliveries = new ConcurrentHashMap<>();
    private final ObjectMapper json;

    public ProofWebhookReceiver(ObjectMapper json) {
        this.json = json;
        String proofId = System.getenv("PBA_PROOF_ID");
        String secret = System.getenv("PBA_WEBHOOK_SECRET");
        if (proofId != null && secret != null) secrets.put(proofId, secret);
    }

    public record Blockchain(String network, String transaction_hash, String explorer_url) {}
    public record ProofCertifiedPayload(
        String event, String proof_id, String status, String file_hash, String filename,
        String verify_url, String certificate_url, String proof_json_url,
        Blockchain blockchain, String timestamp
    ) {}

    public static boolean verify(byte[] rawBody, String signature, String timestamp, String secret, long now) {
        if (secret == null || !timestamp.matches("[0-9]+") || !signature.matches("[0-9a-f]{64}"))
            return false;
        try {
            long seconds = Long.parseLong(timestamp);
            if (seconds < now - 300 || seconds > now + 60) return false;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((timestamp + ".").getBytes(StandardCharsets.US_ASCII));
            byte[] expected = mac.doFinal(rawBody);
            byte[] actual = java.util.HexFormat.of().parseHex(signature);
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception e) {
            return false;
        }
    }

    @PostMapping("/webhooks/prove-before-act")
    public ResponseEntity<Void> receive(
        @RequestBody byte[] rawBody,
        @RequestHeader(value = "X-ProveBeforeAct-Signature", defaultValue = "") String signature,
        @RequestHeader(value = "X-ProveBeforeAct-Timestamp", defaultValue = "") String timestamp,
        @RequestHeader(value = "X-ProveBeforeAct-Event", defaultValue = "") String event,
        @RequestHeader(value = "X-ProveBeforeAct-Delivery", defaultValue = "") String delivery
    ) {
        if (delivery.isEmpty() || !event.equals("proof.certified")) return ResponseEntity.badRequest().build();
        // The delivery ID is only a lookup key until verification succeeds.
        if (!verify(rawBody, signature, timestamp, secrets.get(delivery), Instant.now().getEpochSecond()))
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        try {
            ProofCertifiedPayload payload = json.readValue(rawBody, ProofCertifiedPayload.class);
            if (!delivery.equals(payload.proof_id()) || !event.equals(payload.event())
                || !"certified".equals(payload.status())) return ResponseEntity.badRequest().build();
            deliveries.putIfAbsent(delivery, payload); // Demo only; use a durable atomic insert + action in production.
            return ResponseEntity.ok().build(); // Acknowledge retries.
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    public static void main(String[] args) {
        SpringApplication.run(ProofWebhookReceiver.class, args);
    }
}
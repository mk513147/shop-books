import React, { useEffect } from "react";
import { Text, StyleSheet, View } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	withSpring,
	runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

type ToastVariant = "success" | "error" | "warning" | "info";

type Props = {
	message: string;
	variant: ToastVariant;
	visible: boolean;
	onHide: () => void;
};

export default function AppToast({ message, variant, visible, onHide }: Props) {
	const insets = useSafeAreaInsets();

	const translateY = useSharedValue(-120);
	const opacity = useSharedValue(0);

	// Slide in/out
	useEffect(() => {
		if (visible) {
			translateY.value = withSpring(0);
			opacity.value = withTiming(1);

			const timer = setTimeout(() => {
				dismiss();
			}, 3000);

			return () => clearTimeout(timer);
		}
	}, [visible]);

	const dismiss = () => {
		translateY.value = withTiming(-120);
		opacity.value = withTiming(0);
		runOnJS(onHide)();
	};

	// Swipe gesture
	const panGesture = Gesture.Pan()
		.onUpdate((e) => {
			if (e.translationY < 0) {
				translateY.value = e.translationY;
			}
		})
		.onEnd((e) => {
			if (e.translationY < -40) {
				runOnJS(dismiss)();
			} else {
				translateY.value = withSpring(0);
			}
		});

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: translateY.value }],
		opacity: opacity.value,
	}));

	const config = {
		success: {
			bg: "#16a34a",
			icon: "checkmark-circle",
		},
		error: {
			bg: "#dc2626",
			icon: "close-circle",
		},
		warning: {
			bg: "#f59e0b",
			icon: "warning",
		},
		info: {
			bg: "#2563eb",
			icon: "information-circle",
		},
	}[variant];

	if (!visible) return null;

	return (
		<GestureDetector gesture={panGesture}>
			<Animated.View
				style={[
					styles.toast,
					{
						top: insets.top + 10,
						backgroundColor: config.bg,
					},
					animatedStyle,
				]}
			>
				<View style={styles.row}>
					<Ionicons
						name={config.icon as any}
						size={20}
						color="#fff"
						style={{ marginRight: 8 }}
					/>
					<Text style={styles.text}>{message}</Text>
				</View>
			</Animated.View>
		</GestureDetector>
	);
}

const styles = StyleSheet.create({
	toast: {
		position: "absolute",
		left: 20,
		right: 20,
		paddingVertical: 12,
		paddingHorizontal: 16,
		borderRadius: 12,
		zIndex: 9999,
		elevation: 10,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
	},
	text: {
		color: "#fff",
		fontWeight: "600",
		flex: 1,
	},
});

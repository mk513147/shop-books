import React, { useEffect } from "react";
import { Text, StyleSheet } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ToastVariant = "success" | "error" | "warning" | "info";

type Props = {
	message: string;
	variant: ToastVariant;
	visible: boolean;
	onHide: () => void;
};

export default function AppToast({ message, variant, visible, onHide }: Props) {
	const insets = useSafeAreaInsets();
	const translateY = useSharedValue(-100);
	const opacity = useSharedValue(0);

	useEffect(() => {
		if (visible) {
			translateY.value = withSpring(0);
			opacity.value = withTiming(1, { duration: 200 });

			const timer = setTimeout(() => {
				translateY.value = withTiming(-100);
				opacity.value = withTiming(0, { duration: 200 });
				onHide();
			}, 2500);

			return () => clearTimeout(timer);
		}
	}, [visible]);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: translateY.value }],
		opacity: opacity.value,
	}));

	const backgroundColor = {
		success: "#16a34a",
		error: "#dc2626",
		warning: "#f59e0b",
		info: "#2563eb",
	}[variant];

	if (!visible) return null;

	return (
		<Animated.View
			style={[
				styles.toast,
				{ top: insets.top + 10, backgroundColor },
				animatedStyle,
			]}
		>
			<Text style={styles.text}>{message}</Text>
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	toast: {
		position: "absolute",
		left: 20,
		right: 20,
		paddingVertical: 12,
		paddingHorizontal: 16,
		borderRadius: 10,
		zIndex: 9999,
		elevation: 10,
	},
	text: {
		color: "#fff",
		fontWeight: "600",
	},
});

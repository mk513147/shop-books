import React from "react";
import { View, StyleSheet, Dimensions, Pressable } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	Easing,
	interpolate,
	Extrapolation,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

type Props = {
	children: React.ReactNode;
	collapsedHeight?: number;
	expandedHeight?: number;
};

export default function DraggableBottomSheet({
	children,
	collapsedHeight = 80,
	expandedHeight,
}: Props) {
	const screenHeight = Dimensions.get("window").height;
	const EXPANDED_HEIGHT = expandedHeight ?? screenHeight * 0.6;

	const CLOSED_TRANSLATE_Y = EXPANDED_HEIGHT - collapsedHeight;

	const translateY = useSharedValue(CLOSED_TRANSLATE_Y);
	const startY = useSharedValue(CLOSED_TRANSLATE_Y);

	const openSheet = () => {
		translateY.value = withTiming(0, {
			duration: 250,
			easing: Easing.out(Easing.cubic),
		});
	};

	const closeSheet = () => {
		translateY.value = withTiming(CLOSED_TRANSLATE_Y, {
			duration: 220,
			easing: Easing.out(Easing.cubic),
		});
	};

	const gesture = Gesture.Pan()
		.onStart(() => {
			startY.value = translateY.value;
		})
		.onUpdate((event) => {
			let next = startY.value + event.translationY;

			if (next < 0) next = 0;

			if (next > CLOSED_TRANSLATE_Y) {
				const diff = next - CLOSED_TRANSLATE_Y;

				if (Math.abs(event.velocityY) < 800) {
					next = CLOSED_TRANSLATE_Y + diff * 0.25;
				} else {
					next = CLOSED_TRANSLATE_Y;
				}
			}

			translateY.value = next;
		})
		.onEnd((event) => {
			const velocityThreshold = 700;
			const midpoint = CLOSED_TRANSLATE_Y / 2;

			let destination = CLOSED_TRANSLATE_Y;

			if (event.velocityY > velocityThreshold) {
				destination = CLOSED_TRANSLATE_Y;
			} else if (event.velocityY < -velocityThreshold) {
				destination = 0;
			} else {
				destination = translateY.value < midpoint ? 0 : CLOSED_TRANSLATE_Y;
			}

			translateY.value = withTiming(destination, {
				duration: 220,
				easing: Easing.out(Easing.cubic),
			});
		});

	const sheetStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: translateY.value }],
	}));

	const backdropStyle = useAnimatedStyle(() => {
		const opacity = interpolate(
			translateY.value,
			[0, CLOSED_TRANSLATE_Y],
			[0.5, 0],
			Extrapolation.CLAMP,
		);

		return {
			opacity,
		};
	});

	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="box-none">
			{/* Backdrop */}
			<Animated.View
				style={[styles.backdrop, backdropStyle]}
				pointerEvents="auto"
			>
				<Pressable style={{ flex: 1 }} onPress={closeSheet} />
			</Animated.View>

			{/* Sheet */}
			<GestureDetector gesture={gesture}>
				<Animated.View
					style={[styles.container, { height: EXPANDED_HEIGHT }, sheetStyle]}
				>
					<View style={styles.dragIndicator} />
					{children}
				</Animated.View>
			</GestureDetector>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		backgroundColor: "#fff",
		borderTopLeftRadius: 24,
		borderTopRightRadius: 24,
		paddingHorizontal: 16,
		paddingTop: 10,
		elevation: 10,
	},

	backdrop: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: "black",
	},

	dragIndicator: {
		width: 40,
		height: 4,
		backgroundColor: "#ccc",
		borderRadius: 2,
		alignSelf: "center",
		marginBottom: 8,
	},
});
